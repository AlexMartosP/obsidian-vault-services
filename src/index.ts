import http from "node:http";
import crypto from "node:crypto";
import { getRequestListener } from "@hono/node-server";
import cron, { type ScheduledTask } from "node-cron";

import { ConfigError, loadConfig } from "./config.ts";
import { log, describeError } from "./logger.ts";
import { VaultPaths } from "./vault/paths.ts";
import { VaultStore } from "./vault/store.ts";
import { JiraClient } from "./jira/client.ts";
import { JiraSync } from "./jira/sync.ts";
import { SyncRunner } from "./jira/runner.ts";
import { createApi, createWebhookApi } from "./api/routes.ts";
import { createMcpServer, createMcpTransport } from "./api/mcp.ts";
import { runBackup } from "./backup/run.ts";

function timingSafeEquals(a: string, b: string): boolean {
    const ab = Buffer.from(a);
    const bb = Buffer.from(b);
    if (ab.length !== bb.length) return false;
    return crypto.timingSafeEqual(ab, bb);
}

function readBody(req: http.IncomingMessage): Promise<unknown> {
    return new Promise((resolve, reject) => {
        const chunks: Buffer[] = [];
        let size = 0;
        req.on("data", (chunk: Buffer) => {
            size += chunk.length;
            if (size > 8 * 1024 * 1024) {
                reject(new Error("request body too large"));
                req.destroy();
                return;
            }
            chunks.push(chunk);
        });
        req.on("end", () => {
            const raw = Buffer.concat(chunks).toString("utf8");
            if (raw.trim() === "") {
                resolve(undefined);
                return;
            }
            try {
                resolve(JSON.parse(raw));
            } catch {
                reject(new Error("request body is not valid JSON"));
            }
        });
        req.on("error", reject);
    });
}

async function main(): Promise<void> {
    const config = loadConfig();
    const store = new VaultStore(new VaultPaths(config.vaultDir));

    let syncRunner: SyncRunner | null = null;
    const scheduled: ScheduledTask[] = [];

    if (config.jira !== null) {
        const jiraConfig = config.jira;
        const sync = new JiraSync(store, new JiraClient(jiraConfig), jiraConfig);
        syncRunner = new SyncRunner(sync);
        const runner = syncRunner;

        if (!cron.validate(jiraConfig.reconcileCron)) {
            throw new ConfigError(`JIRA_RECONCILE_CRON is not a valid cron expression: ${jiraConfig.reconcileCron}`);
        }
        scheduled.push(
            cron.schedule(jiraConfig.reconcileCron, () => {
                void runner.run().catch(() => undefined);
            }),
        );
        log.info("jira sync enabled", {
            subdir: jiraConfig.targetSubdir,
            reconcileCron: jiraConfig.reconcileCron,
            webhookSecret: jiraConfig.webhookSecret !== null,
        });

        // Reconcile once at boot so a restart converges immediately.
        void runner.run().catch(() => undefined);
    } else {
        log.info("jira sync disabled, no JIRA_EMAIL or JIRA_API_TOKEN set");
    }

    if (config.backup !== null) {
        const backupConfig = config.backup;
        if (!cron.validate(backupConfig.cron)) {
            throw new ConfigError(`BACKUP_CRON is not a valid cron expression: ${backupConfig.cron}`);
        }
        scheduled.push(
            cron.schedule(backupConfig.cron, () => {
                void runBackup(store.root, backupConfig).catch((err: unknown) => {
                    log.error("scheduled backup threw", { error: describeError(err) });
                });
            }),
        );
        log.info("backup enabled", {
            cron: backupConfig.cron,
            bucket: backupConfig.bucket,
            encryptedArtifact: backupConfig.couch !== null,
        });
    } else {
        log.info("backup disabled, no S3_BUCKET set");
    }

    const api = createApi({ config, store, syncRunner });
    const apiListener = getRequestListener(api.fetch);

    const webhookListener =
        config.jira !== null && syncRunner !== null
            ? getRequestListener(
                  createWebhookApi(
                      config.jira.webhookSecret,
                      syncRunner,
                      config.jira.webhookDebounceMs,
                  ).fetch,
              )
            : null;

    const server = http.createServer((req, res) => {
        const url = req.url ?? "/";

        if (url.startsWith("/jira/webhook")) {
            if (webhookListener === null) {
                res.writeHead(409, { "content-type": "application/json" });
                res.end(JSON.stringify({ error: "jira sync is disabled" }));
                return;
            }
            webhookListener(req, res);
            return;
        }

        if (url === "/mcp" || url.startsWith("/mcp?") || url.startsWith("/mcp/")) {
            void handleMcp(req, res).catch((err: unknown) => {
                log.error("mcp request failed", { error: describeError(err) });
                if (!res.headersSent) {
                    res.writeHead(500, { "content-type": "application/json" });
                }
                res.end(JSON.stringify({ error: "internal error" }));
            });
            return;
        }

        apiListener(req, res);
    });

    async function handleMcp(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
        const header = req.headers.authorization;
        const xKey = req.headers["x-access-key"];
        const presented =
            typeof header === "string" && header.startsWith("Bearer ")
                ? header.slice(7).trim()
                : typeof xKey === "string"
                  ? xKey.trim()
                  : "";
        if (presented === "" || !timingSafeEquals(presented, config.accessKey)) {
            res.writeHead(401, { "content-type": "application/json" });
            res.end(JSON.stringify({ error: "unauthorized" }));
            return;
        }

        // Stateless: a fresh server and transport per request, so concurrent
        // callers cannot collide on JSON-RPC request ids.
        const mcpServer = createMcpServer(store, syncRunner);
        const transport = createMcpTransport();
        res.on("close", () => {
            void transport.close();
            void mcpServer.close();
        });
        await mcpServer.connect(transport);
        const body = req.method === "POST" ? await readBody(req) : undefined;
        await transport.handleRequest(req, res, body);
    }

    server.listen(config.port, () => {
        log.info("vault-service listening", { port: config.port, vault: store.root });
    });

    const shutdown = (signal: string) => {
        log.info("shutting down", { signal });
        for (const task of scheduled) void task.stop();
        syncRunner?.stop();
        server.close(() => process.exit(0));
        // Do not hang forever on a stuck connection.
        setTimeout(() => process.exit(0), 10_000).unref();
    };
    process.on("SIGTERM", () => shutdown("SIGTERM"));
    process.on("SIGINT", () => shutdown("SIGINT"));
}

main().catch((err: unknown) => {
    if (err instanceof ConfigError) {
        log.error("configuration error", { error: err.message });
        process.exit(2);
    }
    log.error("failed to start", { error: describeError(err) });
    process.exit(1);
});
