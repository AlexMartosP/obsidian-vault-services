import type { BackupConfig, Config, JiraConfig } from "./config.ts";
import { log, describeError } from "./logger.ts";
import { JiraClient } from "./jira/client.ts";
import { JiraSync } from "./jira/sync.ts";
import { SyncRunner } from "./jira/runner.ts";
import { runBackup } from "./backup/run.ts";
import type { VaultStore } from "./vault/store.ts";

/**
 * Holds the live configuration and everything derived from it, so the config
 * file can be edited without redeploying or restarting the container.
 *
 * Whether a feature exists at all is decided once at startup, because that
 * depends on credentials in the environment rather than on the file. What the
 * file controls, and what can therefore change underneath a running process,
 * is how an enabled feature behaves: the query, where notes go, the status
 * mapping, the schedules.
 */

export type ReloadOutcome = {
    /** Settings that took effect. */
    applied: string[];
    /** Settings that differ but only take effect on restart. */
    ignored: string[];
    /** Set when the new config was rejected; the previous one is still live. */
    error: string | null;
};

/** Injectable so tests do not register real cron timers. */
export type ScheduledHandle = { stop: () => void };
export type Scheduler = {
    validate(expression: string): boolean;
    schedule(expression: string, task: () => void): ScheduledHandle;
};

function jiraFields(c: JiraConfig): Record<string, string> {
    return {
        "jira.baseUrl": c.baseUrl,
        "jira.jql": c.jql,
        "jira.targetSubdir": c.targetSubdir,
        "jira.taskContext": c.taskContext,
        "jira.statusMap": JSON.stringify(c.statusMap),
        "jira.defaultStatus": c.defaultStatus,
        "jira.reconcileCron": c.reconcileCron,
        "jira.webhookDebounceMs": String(c.webhookDebounceMs),
    };
}

function backupFields(c: BackupConfig): Record<string, string> {
    return {
        "backup.cron": c.cron,
        "backup.bucket": c.bucket,
        "backup.endpoint": String(c.endpoint),
        "backup.region": c.region,
        "backup.prefix": c.prefix,
        "backup.forcePathStyle": String(c.forcePathStyle),
    };
}

function diffKeys(
    before: Record<string, string>,
    after: Record<string, string>,
): string[] {
    const changed: string[] = [];
    for (const [key, value] of Object.entries(after)) {
        if (before[key] !== value) changed.push(key);
    }
    return changed;
}

export class Runtime {
    private current: Config;
    private jiraSync: JiraSync | null = null;
    private jiraTask: ScheduledHandle | null = null;
    private backupTask: ScheduledHandle | null = null;
    readonly syncRunner: SyncRunner | null;

    constructor(
        initial: Config,
        private readonly store: VaultStore,
        private readonly scheduler: Scheduler,
    ) {
        this.current = initial;

        if (initial.jira !== null) {
            this.jiraSync = this.buildSync(initial.jira);
            // The runner asks for the current sync on each run, so a reload
            // between runs is picked up without losing its status or its
            // pending debounce.
            this.syncRunner = new SyncRunner(() => this.jiraSync);
        } else {
            this.syncRunner = null;
        }
    }

    get config(): Config {
        return this.current;
    }

    private buildSync(jira: JiraConfig): JiraSync {
        return new JiraSync(this.store, new JiraClient(jira), jira);
    }

    /** Register the cron tasks for the current config. */
    start(): void {
        this.scheduleJira();
        this.scheduleBackup();
    }

    private scheduleJira(): void {
        this.jiraTask?.stop();
        this.jiraTask = null;
        const jira = this.current.jira;
        const runner = this.syncRunner;
        if (jira === null || runner === null) return;
        if (!this.scheduler.validate(jira.reconcileCron)) {
            log.error("ignoring an invalid reconcile cron expression", {
                reconcileCron: jira.reconcileCron,
            });
            return;
        }
        this.jiraTask = this.scheduler.schedule(jira.reconcileCron, () => {
            void runner.run().catch(() => undefined);
        });
    }

    private scheduleBackup(): void {
        this.backupTask?.stop();
        this.backupTask = null;
        const backup = this.current.backup;
        if (backup === null) return;
        if (!this.scheduler.validate(backup.cron)) {
            log.error("ignoring an invalid backup cron expression", { cron: backup.cron });
            return;
        }
        const root = this.store.root;
        this.backupTask = this.scheduler.schedule(backup.cron, () => {
            void runBackup(root, backup).catch((err: unknown) => {
                log.error("scheduled backup threw", { error: describeError(err) });
            });
        });
    }

    /**
     * Swap in a freshly loaded config.
     *
     * The caller is responsible for producing `next`; a failure to even parse
     * the file never reaches here, which is what keeps the last good config
     * live when someone saves a broken edit.
     */
    apply(next: Config): ReloadOutcome {
        const previous = this.current;
        const applied: string[] = [];
        const ignored: string[] = [];

        // Bound listener and constructed store cannot change under a running
        // process. Report rather than silently discard.
        if (next.port !== previous.port) ignored.push("server.port");
        if (next.vaultDir !== previous.vaultDir) ignored.push("vaultDir");

        if (previous.jira !== null && next.jira !== null) {
            applied.push(...diffKeys(jiraFields(previous.jira), jiraFields(next.jira)));
        }
        if (previous.backup !== null && next.backup !== null) {
            applied.push(...diffKeys(backupFields(previous.backup), backupFields(next.backup)));
        }

        // Feature existence is fixed at startup, since it follows credentials
        // in the environment rather than the file.
        if ((previous.jira === null) !== (next.jira === null)) ignored.push("jira (enablement)");
        if ((previous.backup === null) !== (next.backup === null)) {
            ignored.push("backup (enablement)");
        }

        if (applied.length === 0 && ignored.length === 0) {
            return { applied, ignored, error: null };
        }

        // Keep the port and vault the process actually started with, so the
        // live config never claims something untrue.
        this.current = {
            ...next,
            port: previous.port,
            vaultDir: previous.vaultDir,
            jira: previous.jira === null ? null : next.jira,
            backup: previous.backup === null ? null : next.backup,
        };

        if (this.current.jira !== null) this.jiraSync = this.buildSync(this.current.jira);

        const rescheduleJira = applied.some((k) => k === "jira.reconcileCron");
        const rescheduleBackup = applied.some((k) => k === "backup.cron");
        if (rescheduleJira) this.scheduleJira();
        if (rescheduleBackup) this.scheduleBackup();
        // The backup task closes over its config, so any backup change needs
        // the task rebuilt, not just a cron change.
        else if (applied.some((k) => k.startsWith("backup."))) this.scheduleBackup();

        if (applied.length > 0) log.info("configuration reloaded", { applied });
        if (ignored.length > 0) {
            log.warn("some changes need a restart and were not applied", { ignored });
        }
        return { applied, ignored, error: null };
    }

    stop(): void {
        this.jiraTask?.stop();
        this.backupTask?.stop();
        this.syncRunner?.stop();
    }
}
