import { Hono } from "hono";
import crypto from "node:crypto";
import { z } from "zod";

import type { Config } from "../config.ts";
import { describeError, log } from "../logger.ts";
import { PathOutsideVaultError } from "../vault/paths.ts";
import type { VaultStore } from "../vault/store.ts";
import type { SyncRunner } from "../jira/runner.ts";
import { runBackup } from "../backup/run.ts";

export type Services = {
    config: Config;
    store: VaultStore;
    syncRunner: SyncRunner | null;
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

export function createApi(services: Services): Hono {
    const app = new Hono();
    const { config, store } = services;

    app.get("/health", (c) =>
        c.json({
            ok: true,
            vault: store.root,
            jira: config.jira !== null,
            backup: config.backup !== null,
        }),
    );

    // Everything below requires the access key.
    app.use("/v1/*", async (c, next) => {
        const key = presentedKey(c.req.header("authorization"), c.req.header("x-access-key"));
        if (key === null || !secretsMatch(key, config.accessKey)) {
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

    app.put("/v1/note", async (c) => {
        const parsed = writeBody.safeParse(await c.req.json().catch(() => null));
        if (!parsed.success) return c.json({ error: "expected { path, content }" }, 400);
        await store.write(parsed.data.path, parsed.data.content);
        return c.json({ path: parsed.data.path, written: true });
    });

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
        if (services.syncRunner === null) return c.json({ enabled: false });
        return c.json({ enabled: true, ...services.syncRunner.status });
    });

    app.post("/v1/jira/sync", async (c) => {
        if (services.syncRunner === null) return c.json({ error: "jira sync is disabled" }, 409);
        try {
            return c.json(await services.syncRunner.run());
        } catch (err) {
            // The vault is untouched on failure, so this is safe to surface as 502.
            return c.json({ error: describeError(err) }, 502);
        }
    });

    app.post("/v1/backup/run", async (c) => {
        if (config.backup === null) return c.json({ error: "backup is disabled" }, 409);
        const report = await runBackup(store.root, config.backup);
        return c.json(report, report.failures.length > 0 ? 207 : 200);
    });

    return app;
}

/**
 * Jira webhooks authenticate with their own shared secret rather than the
 * access key, because Jira cannot be told to send an arbitrary header value
 * securely. Mounted separately so it is never behind the access key check.
 */
export function createWebhookApi(
    secret: string | null,
    runner: SyncRunner,
    debounceMs: number,
): Hono {
    const app = new Hono();
    app.post("/jira/webhook", async (c) => {
        if (secret !== null) {
            const presented = c.req.query("secret") ?? c.req.header("x-hub-signature") ?? "";
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
