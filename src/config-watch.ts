import fs from "node:fs";
import type { Config } from "./config.ts";
import { log, describeError } from "./logger.ts";
import type { ReloadOutcome, Runtime } from "./runtime.ts";

/**
 * Picks up edits to the config file without a restart.
 *
 * Polling, not fs.watch, on purpose. inotify events do not reliably cross a
 * Docker bind mount, which is exactly how this file is delivered in
 * production, and an editor that writes via a temp file and rename can drop
 * the watch entirely. Comparing mtime and size every few seconds is dull and
 * dependable, and the cost is one stat call.
 *
 * A file that fails to parse or validate is reported and then ignored: the
 * previously loaded configuration stays live, so a typo during an edit cannot
 * take the service down or quietly revert it to defaults.
 */

type Fingerprint = { mtimeMs: number; size: number } | null;

function fingerprint(path: string): Fingerprint {
    try {
        const st = fs.statSync(path);
        return { mtimeMs: st.mtimeMs, size: st.size };
    } catch {
        return null; // absent is a legitimate state, defaults then apply
    }
}

function same(a: Fingerprint, b: Fingerprint): boolean {
    if (a === null || b === null) return a === b;
    return a.mtimeMs === b.mtimeMs && a.size === b.size;
}

export class ConfigWatcher {
    private last: Fingerprint;
    private timer: NodeJS.Timeout | null = null;
    private lastError: string | null = null;
    private lastReloadAt: string | null = null;

    /**
     * `load` is injected rather than calling loadConfig directly, so the file
     * being watched and the file being read are guaranteed to be the same one.
     * Reaching for process.env here would let the two diverge whenever
     * CONFIG_FILE is unset and the default path differs from what was resolved
     * at startup.
     */
    constructor(
        private readonly path: string,
        private readonly runtime: Runtime,
        private readonly intervalMs: number,
        private readonly load: () => Config,
    ) {
        this.last = fingerprint(path);
    }

    get status(): {
        path: string;
        watching: boolean;
        intervalMs: number;
        lastReloadAt: string | null;
        lastError: string | null;
    } {
        return {
            path: this.path,
            watching: this.timer !== null,
            intervalMs: this.intervalMs,
            lastReloadAt: this.lastReloadAt,
            lastError: this.lastError,
        };
    }

    start(): void {
        if (this.timer !== null) return;
        this.timer = setInterval(() => {
            const current = fingerprint(this.path);
            if (same(current, this.last)) return;
            this.last = current;
            log.info("config file changed, reloading", { path: this.path });
            this.reload();
        }, this.intervalMs);
        // Must not hold the process open on its own.
        this.timer.unref();
    }

    /**
     * Re-read and apply. Exposed so the API can force a reload rather than
     * waiting out the poll interval.
     */
    reload(): ReloadOutcome {
        let next: Config;
        try {
            next = this.load();
        } catch (err) {
            this.lastError = describeError(err);
            this.lastReloadAt = new Date().toISOString();
            log.error("rejected a config change, keeping the previous configuration", {
                error: this.lastError,
            });
            return { applied: [], ignored: [], error: this.lastError };
        }

        // Re-reading succeeded, so take this as the new baseline even if the
        // caller forced it rather than the poller noticing.
        this.last = fingerprint(this.path);
        this.lastError = null;
        this.lastReloadAt = new Date().toISOString();
        return this.runtime.apply(next);
    }

    stop(): void {
        if (this.timer !== null) {
            clearInterval(this.timer);
            this.timer = null;
        }
    }
}
