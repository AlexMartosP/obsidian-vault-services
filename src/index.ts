import http from "node:http";
import crypto from "node:crypto";
import { getRequestListener } from "@hono/node-server";
import cron from "node-cron";

import { ConfigError, loadConfig, resolveConfigFilePath } from "./config.ts";
import { log, describeError } from "./logger.ts";
import { VaultPaths } from "./vault/paths.ts";
import { VaultStore } from "./vault/store.ts";
import { createApi, createPublicApi, createWebhookApi, matchClient } from "./api/routes.ts";
import { ScopedStore } from "./vault/scoped.ts";
import { createMcpServer, createMcpTransport } from "./api/mcp.ts";
import { Runtime, type Scheduler } from "./runtime.ts";
import { ConfigWatcher } from "./config-watch.ts";

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

    const scheduler: Scheduler = {
        validate: (expression) => cron.validate(expression),
        schedule: (expression, task) => cron.schedule(expression, task),
    };

    // Validate the startup schedules up front, so a bad expression is a clear
    // boot failure rather than a feature that silently never runs. Reloads are
    // more forgiving: a bad cron there is logged and the old one kept.
    if (config.jira !== null && !cron.validate(config.jira.reconcileCron)) {
        throw new ConfigError(
            `jira.reconcileCron is not a valid cron expression: ${config.jira.reconcileCron}`,
        );
    }
    if (config.backup !== null && !cron.validate(config.backup.cron)) {
        throw new ConfigError(`backup.cron is not a valid cron expression: ${config.backup.cron}`);
    }

    const runtime = new Runtime(config, store, scheduler);
    runtime.start();

    const watcher = new ConfigWatcher(
        resolveConfigFilePath(),
        runtime,
        config.configPollMs,
        () => loadConfig(),
    );
    watcher.start();

    log.info("configuration", {
        configFile: config.configFile,
        watchingForChanges: true,
        pollMs: config.configPollMs,
        jira: config.jira !== null,
        backup: config.backup !== null,
    });

    if (config.jira !== null) {
        log.info("jira sync enabled", {
            subdir: config.jira.targetSubdir,
            reconcileCron: config.jira.reconcileCron,
            webhookSecret: config.jira.webhookSecret !== null,
        });
        // Reconcile once at boot so a restart converges immediately.
        void runtime.syncRunner?.run().catch(() => undefined);
    } else {
        log.info("jira sync disabled, no JIRA_EMAIL or JIRA_API_TOKEN set");
    }

    if (config.backup !== null) {
        log.info("backup enabled", {
            cron: config.backup.cron,
            bucket: config.backup.bucket,
            encryptedArtifact: config.backup.couch !== null,
        });
    } else {
        log.info("backup disabled, no S3 credentials set");
    }

    const api = createApi({ runtime, store, watcher });
    const apiListener = getRequestListener(api.fetch);

    const syncRunner = runtime.syncRunner;
    const webhookListener =
        config.jira !== null && syncRunner !== null
            ? getRequestListener(
                  createWebhookApi(runtime, syncRunner).fetch,
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
            void handleMcp(
                req,
                res,
                () => runtime.config.accessKey,
                () => createMcpServer(store, syncRunner, watcher),
            ).catch((err: unknown) => {
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

    async function handleMcp(
        req: http.IncomingMessage,
        res: http.ServerResponse,
        expectedKey: () => string,
        makeServer: () => ReturnType<typeof createMcpServer>,
    ): Promise<void> {
        const header = req.headers.authorization;
        const xKey = req.headers["x-access-key"];
        const presented =
            typeof header === "string" && header.startsWith("Bearer ")
                ? header.slice(7).trim()
                : typeof xKey === "string"
                  ? xKey.trim()
                  : "";
        if (presented === "" || !timingSafeEquals(presented, expectedKey())) {
            res.writeHead(401, { "content-type": "application/json" });
            res.end(JSON.stringify({ error: "unauthorized" }));
            return;
        }

        // Stateless: a fresh server and transport per request, so concurrent
        // callers cannot collide on JSON-RPC request ids.
        const mcpServer = makeServer();
        const transport = createMcpTransport();
        res.on("close", () => {
            void transport.close();
            void mcpServer.close();
        });
        await mcpServer.connect(transport);
        const body = req.method === "POST" ? await readBody(req) : undefined;
        await transport.handleRequest(req, res, body);
    }

    /**
     * MCP on the public listener. Resolves the client from the key first, so
     * the tools it registers operate on a store confined to that client's
     * subdirectory rather than the whole vault.
     */
    async function handleScopedMcp(
        req: http.IncomingMessage,
        res: http.ServerResponse,
    ): Promise<void> {
        const clients = runtime.config.publicApi?.clients ?? [];
        const header = req.headers.authorization;
        const xKey = req.headers["x-access-key"];
        const presented =
            typeof header === "string" && header.startsWith("Bearer ")
                ? header.slice(7).trim()
                : typeof xKey === "string"
                  ? xKey.trim()
                  : "";
        const client = presented === "" ? null : matchClient(clients, presented);
        if (client === null) {
            res.writeHead(401, { "content-type": "application/json" });
            res.end(JSON.stringify({ error: "unauthorized" }));
            return;
        }

        const scoped = new ScopedStore(store, client.subdir);
        const mcpServer = createMcpServer(scoped, null);
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

    /**
     * Optional second listener carrying only the vault surface, for putting
     * behind a domain. It has its own key and a vault-only MCP tool set, so
     * exposing it cannot reach Jira, backups or the config reload.
     */
    let publicServer: http.Server | null = null;
    const publicApi = config.publicApi;
    if (publicApi !== null) {
        const publicListener = getRequestListener(
            createPublicApi({
                store,
                // Read through the runtime so a reloaded scope applies without
                // a restart; fall back to the boot value if the group vanishes.
                clients: () => runtime.config.publicApi?.clients ?? publicApi.clients,
            }).fetch,
        );
        publicServer = http.createServer((req, res) => {
            const url = req.url ?? "/";
            if (url === "/mcp" || url.startsWith("/mcp?") || url.startsWith("/mcp/")) {
                void handleScopedMcp(req, res).catch((err: unknown) => {
                    log.error("public mcp request failed", { error: describeError(err) });
                    if (!res.headersSent) {
                        res.writeHead(500, { "content-type": "application/json" });
                    }
                    res.end(JSON.stringify({ error: "internal error" }));
                });
                return;
            }
            publicListener(req, res);
        });
        publicServer.listen(publicApi.port, () => {
            log.info("public vault API listening", {
                port: publicApi.port,
                clients: (runtime.config.publicApi?.clients ?? publicApi.clients).map((c) => ({
                    name: c.name,
                    subdir: c.subdir === "" ? "(whole vault)" : c.subdir,
                })),
            });
        });
    } else {
        log.info("public vault API disabled, no PUBLIC_PORT or PUBLIC_ACCESS_KEY set");
    }

    const shutdown = (signal: string) => {
        log.info("shutting down", { signal });
        watcher.stop();
        runtime.stop();
        publicServer?.close();
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
