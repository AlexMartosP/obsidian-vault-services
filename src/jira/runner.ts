import { log, describeError } from "../logger.ts";
import type { JiraSync, ReconcileResult } from "./sync.ts";

/**
 * Serialises reconciles.
 *
 * Webhooks arrive in bursts (one issue transition can emit several events) and
 * the cron tick can land mid burst. Running two reconciles at once would have
 * them race on the same files, so requests coalesce instead: one run in
 * flight, and at most one follow up queued no matter how many requests arrive
 * while it is running.
 */
export class SyncRunner {
    private running: Promise<ReconcileResult> | null = null;
    private followUpQueued = false;
    private debounceTimer: NodeJS.Timeout | null = null;
    private lastResult: ReconcileResult | null = null;
    private lastError: string | null = null;
    private lastRunAt: string | null = null;

    constructor(private readonly sync: JiraSync) {}

    get status(): {
        running: boolean;
        lastRunAt: string | null;
        lastResult: ReconcileResult | null;
        lastError: string | null;
    } {
        return {
            running: this.running !== null,
            lastRunAt: this.lastRunAt,
            lastResult: this.lastResult,
            lastError: this.lastError,
        };
    }

    /** Run now, or join the run already in flight. */
    async run(): Promise<ReconcileResult> {
        if (this.running !== null) {
            this.followUpQueued = true;
            return this.running;
        }
        this.running = this.execute();
        try {
            return await this.running;
        } finally {
            this.running = null;
            if (this.followUpQueued) {
                this.followUpQueued = false;
                // Deliberately not awaited: the caller's result is already settled.
                void this.run().catch(() => undefined);
            }
        }
    }

    private async execute(): Promise<ReconcileResult> {
        const started = Date.now();
        try {
            const result = await this.sync.reconcile();
            this.lastResult = result;
            this.lastError = null;
            this.lastRunAt = new Date().toISOString();
            log.info("jira reconcile complete", { ...result, ms: Date.now() - started });
            return result;
        } catch (err) {
            this.lastError = describeError(err);
            this.lastRunAt = new Date().toISOString();
            log.error("jira reconcile failed, vault left unchanged", { error: this.lastError });
            throw err;
        }
    }

    /**
     * Collapse a burst of webhook events into a single run shortly after the
     * last one, rather than reconciling once per event.
     */
    requestDebounced(delayMs: number): void {
        if (this.debounceTimer !== null) clearTimeout(this.debounceTimer);
        this.debounceTimer = setTimeout(() => {
            this.debounceTimer = null;
            void this.run().catch(() => undefined);
        }, delayMs);
    }

    stop(): void {
        if (this.debounceTimer !== null) {
            clearTimeout(this.debounceTimer);
            this.debounceTimer = null;
        }
    }
}
