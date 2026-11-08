import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import crypto from "node:crypto";
import { z } from "zod";

import type { Runtime } from "../runtime.ts";
import type { ConfigWatcher } from "../config-watch.ts";
import { describeError, log } from "../logger.ts";
import { PathOutsideVaultError } from "../vault/paths.ts";
import type { VaultStore } from "../vault/store.ts";
import type { SyncRunner } from "../jira/runner.ts";
import { runBackup } from "../backup/run.ts";

export type Services = {
    runtime: Runtime;
    store: VaultStore;
    watcher: ConfigWatcher;
};

/** Constant time comparison, so a wrong key cannot be found byte by byte. */
function secretsMatch(a: string, b: string): boolean {
    const ab = Buffer.from(a);
    const bb = Buffer.from(b);
    if (ab.length !== bb.length) return false;
    return crypto.timingSafeEqual(ab, bb);
}

function presentedKey(header: string | undefined, xKey: string | undefined): string | null {
    if (header !== undefined && header.startsWith("Bearer ")) return header.slice(7).trim();
    if (xKey !== undefined && xKey.trim() !== "") return xKey.trim();
    return null;
}

const writeBody = z.object({
    path: z.string().min(1),
    content: z.string(),
});

/**
 * Same ceiling the MCP handler applies. Without it `c.req.json()` buffers an
 * unbounded body, so one authenticated caller could exhaust memory and disk
 * with a single note.
 */
const MAX_BODY_BYTES = 8 * 1024 * 1024;

export function createApi(services: Services): Hono {
    const app = new Hono();
    const { runtime, store, watcher } = services;
    // Read through the runtime rather than capturing it: a reload replaces the
    // live config, and a captured copy would go stale.
    const config = () => runtime.config;

    app.get("/health", (c) =>
        c.json({
            ok: true,
            vault: store.root,
            jira: config().jira !== null,
            backup: config().backup !== null,
        }),
    );

    // Everything below requires the access key.
    app.use("/v1/*", async (c, next) => {
        const key = presentedKey(c.req.header("authorization"), c.req.header("x-access-key"));
        if (key === null || !secretsMatch(key, config().accessKey)) {
            return c.json({ error: "unauthorized" }, 401);
        }
        await next();
    });

    app.onError((err, c) => {
        if (err instanceof PathOutsideVaultError) {
            return c.json({ error: "invalid path" }, 400);
        }
        log.error("request failed", { path: c.req.path, error: describeError(err) });
        return c.json({ error: "internal error" }, 500);
    });

    app.get("/v1/notes", async (c) => {
        const subdir = c.req.query("subdir") ?? "";
        const extParam = c.req.query("ext");
        const ext = extParam === "all" ? null : (extParam ?? ".md");
        return c.json({ notes: await store.list(subdir, ext) });
    });

    app.get("/v1/note", async (c) => {
        const p = c.req.query("path");
        if (p === undefined || p === "") return c.json({ error: "path is required" }, 400);
        const content = await store.read(p);
        if (content === null) return c.json({ error: "not found" }, 404);
        return c.json({ path: p, content });
    });

    app.put(
        "/v1/note",
        bodyLimit({
            maxSize: MAX_BODY_BYTES,
            onError: (c) => c.json({ error: "note is too large" }, 413),
        }),
        async (c) => {
            const parsed = writeBody.safeParse(await c.req.json().catch(() => null));
            if (!parsed.success) return c.json({ error: "expected { path, content }" }, 400);
            await store.write(parsed.data.path, parsed.data.content);
            return c.json({ path: parsed.data.path, written: true });
        },
    );

    app.delete("/v1/note", async (c) => {
        const p = c.req.query("path");
        if (p === undefined || p === "") return c.json({ error: "path is required" }, 400);
        const removed = await store.remove(p);
        return c.json({ path: p, removed });
    });

    app.get("/v1/search", async (c) => {
        const q = c.req.query("q");
        if (q === undefined || q === "") return c.json({ error: "q is required" }, 400);
        const subdir = c.req.query("subdir") ?? "";
        const needle = q.toLowerCase();
        const hits: { path: string; line: number; text: string }[] = [];
        for (const entry of await store.list(subdir)) {
            const content = await store.read(entry.path);
            if (content === null) continue;
            const lines = content.split("\n");
            for (let i = 0; i < lines.length; i++) {
                const line = lines[i];
                if (line === undefined) continue;
                if (line.toLowerCase().includes(needle)) {
                    hits.push({ path: entry.path, line: i + 1, text: line.trim() });
                    if (hits.length >= 200) return c.json({ hits, truncated: true });
                }
            }
        }
        return c.json({ hits, truncated: false });
    });

    app.get("/v1/jira/status", (c) => {
        const runner = runtime.syncRunner;
        if (runner === null) return c.json({ enabled: false });
        const jira = config().jira;
        return c.json({
            enabled: true,
            ...runner.status,
            // Echo the settings actually in force, so a reload is observable.
            jql: jira?.jql ?? null,
            targetSubdir: jira?.targetSubdir ?? null,
        });
    });

    app.post("/v1/jira/sync", async (c) => {
        const runner = runtime.syncRunner;
        if (runner === null) return c.json({ error: "jira sync is disabled" }, 409);
        try {
            return c.json(await runner.run());
        } catch (err) {
            // The vault is untouched on failure, so this is safe to surface as 502.
            return c.json({ error: describeError(err) }, 502);
        }
    });

    app.post("/v1/backup/run", async (c) => {
        const backup = config().backup;
        if (backup === null) return c.json({ error: "backup is disabled" }, 409);
        const report = await runBackup(store.root, backup);
        return c.json(report, report.failures.length > 0 ? 207 : 200);
    });

    /** What is actually in force right now, secrets omitted. */
    app.get("/v1/config", (c) => {
        const live = config();
        return c.json({
            watcher: watcher.status,
            vaultDir: live.vaultDir,
            port: live.port,
            jira:
                live.jira === null
                    ? null
                    : {
                          baseUrl: live.jira.baseUrl,
                          jql: live.jira.jql,
                          targetSubdir: live.jira.targetSubdir,
                          taskContext: live.jira.taskContext,
                          statusMap: live.jira.statusMap,
                          defaultStatus: live.jira.defaultStatus,
                          reconcileCron: live.jira.reconcileCron,
                          webhookDebounceMs: live.jira.webhookDebounceMs,
                      },
            backup:
                live.backup === null
                    ? null
                    : {
                          cron: live.backup.cron,
                          bucket: live.backup.bucket,
                          endpoint: live.backup.endpoint,
                          region: live.backup.region,
                          prefix: live.backup.prefix,
                          encryptedArtifact: live.backup.couch !== null,
                      },
        });
    });

    /** Force a re-read instead of waiting out the poll interval. */
    app.post("/v1/config/reload", (c) => {
        const outcome = watcher.reload();
        // A rejected edit leaves the previous config live, which is a client
        // error in the file rather than a server fault.
        return c.json(outcome, outcome.error === null ? 200 : 422);
    });

    return app;
}

/**
 * Jira webhooks authenticate with their own shared secret rather than the
 * access key, because Jira cannot be told to send an arbitrary header value
 * securely. Mounted separately so it is never behind the access key check.
 */
export function createWebhookApi(runtime: Runtime, runner: SyncRunner): Hono {
    const app = new Hono();
    app.post("/jira/webhook", async (c) => {
        // Read per request so a reloaded secret or debounce takes effect.
        const jira = runtime.config.jira;
        const secret = jira?.webhookSecret ?? null;
        const debounceMs = jira?.webhookDebounceMs ?? 2000;
        if (secret !== null) {
            // Named plainly: this is the shared secret itself, not an HMAC
            // signature over the payload. x-hub-signature would have implied
            // GitHub-style signing that is not implemented here.
            const presented = c.req.query("secret") ?? c.req.header("x-webhook-secret") ?? "";
            if (!secretsMatch(presented, secret)) {
                return c.json({ error: "unauthorized" }, 401);
            }
        }
        // The payload is deliberately ignored. A full reconcile is one JQL call
        // and is immune to missed, duplicated or reordered events.
        runner.requestDebounced(debounceMs);
        return c.json({ accepted: true });
    });
    return app;
}
