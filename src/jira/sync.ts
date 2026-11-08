import type { JiraConfig } from "../config.ts";
import { log } from "../logger.ts";
import { safeFilename } from "../vault/paths.ts";
import type { VaultStore } from "../vault/store.ts";
import {
    parseSyncOwnedNote,
    renderJiraNote,
    sameIgnoringModified,
} from "../vault/tasknotes.ts";
import type { JiraIssue } from "./client.ts";

/**
 * Only the search call is needed here. Depending on the capability rather than
 * the concrete client keeps the reconcile logic testable without HTTP.
 */
export type IssueSource = {
    searchActive(signal?: AbortSignal): Promise<JiraIssue[]>;
};

export type ReconcileResult = {
    active: number;
    added: number;
    updated: number;
    removed: number;
    /** Extra notes sharing a Jira key that were pruned. */
    deduped: number;
};

type OwnedNote = {
    relPath: string;
    dateCreated: string | null;
};

export class JiraSync {
    /** Config map with lowercased keys, so lookup tolerates casing drift. */
    private readonly statusLookup: Map<string, string>;
    /** Statuses already warned about, so an unmapped one logs once, not per note. */
    private readonly warnedStatuses = new Set<string>();

    constructor(
        private readonly store: VaultStore,
        private readonly client: IssueSource,
        private readonly config: JiraConfig,
    ) {
        this.statusLookup = new Map(
            Object.entries(config.statusMap).map(([jira, task]) => [jira.toLowerCase(), task]),
        );
    }

    /**
     * Translate a Jira status into a TaskNotes status value.
     *
     * An unmapped status is not an error, since that would stop the sync
     * outright, but it is warned about once: it usually means the JQL was
     * widened without updating `jira.statusMap`.
     */
    private taskStatusFor(jiraStatus: string): string {
        const mapped = this.statusLookup.get(jiraStatus.toLowerCase());
        if (mapped !== undefined) return mapped;
        if (!this.warnedStatuses.has(jiraStatus)) {
            this.warnedStatuses.add(jiraStatus);
            log.warn("Jira status is not in statusMap, using defaultStatus", {
                jiraStatus,
                defaultStatus: this.config.defaultStatus,
            });
        }
        return this.config.defaultStatus;
    }

    /**
     * Bring the target folder in line with Jira.
     *
     * Jira is queried first and a failure propagates before anything is
     * written or deleted, so a network blip can never empty the folder.
     */
    async reconcile(signal?: AbortSignal): Promise<ReconcileResult> {
        const issues = await this.client.searchActive(signal);
        const active = new Map<string, JiraIssue>();
        for (const issue of issues) active.set(issue.key, issue);

        const { owned, duplicates } = await this.scanOwned();

        const now = new Date();
        let added = 0;
        let updated = 0;
        let removed = 0;

        for (const [key, issue] of active) {
            const existing = owned.get(key) ?? null;
            const desiredPath = this.pathFor(issue);
            const content = renderJiraNote({
                key: issue.key,
                summary: issue.summary,
                jiraStatus: issue.status,
                issueType: issue.issueType,
                browseUrl: `${this.config.baseUrl.replace(/\/+$/, "")}/browse/${issue.key}`,
                taskStatus: this.taskStatusFor(issue.status),
                context: this.config.taskContext,
                dateCreated: existing?.dateCreated ?? null,
                now,
            });

            if (existing === null) {
                await this.store.write(desiredPath, content);
                added++;
                continue;
            }

            if (existing.relPath === desiredPath) {
                const current = await this.store.read(desiredPath);
                if (current !== null && sameIgnoringModified(current, content)) continue;
                await this.store.write(desiredPath, content);
                updated++;
                continue;
            }

            // The summary changed, so the filename moves with it.
            await this.store.write(desiredPath, content);
            await this.store.remove(existing.relPath);
            updated++;
        }

        for (const [key, note] of owned) {
            if (active.has(key)) continue;
            if (await this.store.remove(note.relPath)) removed++;
        }

        let deduped = 0;
        for (const extra of duplicates) {
            if (await this.store.remove(extra)) deduped++;
        }

        return { active: active.size, added, updated, removed, deduped };
    }

    private pathFor(issue: JiraIssue): string {
        const title = issue.summary === "" ? issue.key : `${issue.key} ${issue.summary}`;
        return `${this.config.targetSubdir}/${safeFilename(title)}`;
    }

    /**
     * Index the notes this service owns, keyed by Jira key.
     *
     * A key can legitimately appear more than once, for instance if a note was
     * copied by hand or two devices raced a rename. Rather than trusting
     * whichever file the directory listing yields first, the lexicographically
     * first path wins and the rest are reported for pruning.
     */
    private async scanOwned(): Promise<{
        owned: Map<string, OwnedNote>;
        duplicates: string[];
    }> {
        const entries = await this.store.list(this.config.targetSubdir);
        const byKey = new Map<string, OwnedNote[]>();

        for (const entry of entries) {
            const content = await this.store.read(entry.path);
            if (content === null) continue;
            const parsed = parseSyncOwnedNote(content);
            if (parsed === null) continue; // hand written, not ours to touch
            const list = byKey.get(parsed.jiraKey) ?? [];
            list.push({ relPath: entry.path, dateCreated: parsed.dateCreated });
            byKey.set(parsed.jiraKey, list);
        }

        const owned = new Map<string, OwnedNote>();
        const duplicates: string[] = [];
        for (const [key, notes] of byKey) {
            notes.sort((a, b) => a.relPath.localeCompare(b.relPath));
            const [canonical, ...extras] = notes;
            if (canonical === undefined) continue;
            owned.set(key, canonical);
            if (extras.length > 0) {
                log.warn("duplicate notes for one Jira key, pruning extras", {
                    jiraKey: key,
                    keeping: canonical.relPath,
                    pruning: extras.map((e) => e.relPath),
                });
                duplicates.push(...extras.map((e) => e.relPath));
            }
        }

        return { owned, duplicates };
    }
}
