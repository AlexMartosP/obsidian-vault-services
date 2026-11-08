import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

import { describeError } from "../logger.ts";
import { PathOutsideVaultError } from "../vault/paths.ts";
import type { VaultStore } from "../vault/store.ts";
import type { SyncRunner } from "../jira/runner.ts";

type TextResult = {
    content: { type: "text"; text: string }[];
    isError?: boolean;
};

function ok(text: string): TextResult {
    return { content: [{ type: "text", text }] };
}

function fail(text: string): TextResult {
    return { content: [{ type: "text", text }], isError: true };
}

/** Turn a thrown value into a tool error rather than a transport failure. */
async function guarded(run: () => Promise<TextResult>): Promise<TextResult> {
    try {
        return await run();
    } catch (err) {
        if (err instanceof PathOutsideVaultError) return fail("invalid path");
        return fail(describeError(err));
    }
}

export function createMcpServer(
    store: VaultStore,
    syncRunner: SyncRunner | null,
    watcher?: { reload: () => { applied: string[]; ignored: string[]; error: string | null } },
): McpServer {
    const server = new McpServer({ name: "vault-service", version: "0.1.0" });

    server.registerTool(
        "vault_list",
        {
            title: "List vault notes",
            description:
                "List notes in the Obsidian vault. Returns vault relative paths with size and modified time.",
            inputSchema: {
                subdir: z.string().default("").describe("Vault relative folder, empty for the whole vault"),
                includeNonMarkdown: z.boolean().default(false),
            },
        },
        ({ subdir, includeNonMarkdown }) =>
            guarded(async () => {
                const entries = await store.list(subdir, includeNonMarkdown ? null : ".md");
                return ok(JSON.stringify(entries, null, 2));
            }),
    );

    server.registerTool(
        "vault_read",
        {
            title: "Read a vault note",
            description: "Return the full markdown content of one note.",
            inputSchema: { path: z.string().describe("Vault relative path, e.g. Notes/Example.md") },
        },
        ({ path }) =>
            guarded(async () => {
                const content = await store.read(path);
                return content === null ? fail(`not found: ${path}`) : ok(content);
            }),
    );

    server.registerTool(
        "vault_write",
        {
            title: "Write a vault note",
            description:
                "Create or overwrite a note. Writes are atomic. Parent folders are created as needed.",
            inputSchema: {
                path: z.string().describe("Vault relative path"),
                content: z.string().describe("Full file content, this replaces the file"),
            },
        },
        ({ path, content }) =>
            guarded(async () => {
                await store.write(path, content);
                return ok(`written: ${path}`);
            }),
    );

    server.registerTool(
        "vault_delete",
        {
            title: "Delete a vault note",
            description: "Delete one note. Reports whether the file existed.",
            inputSchema: { path: z.string().describe("Vault relative path") },
        },
        ({ path }) =>
            guarded(async () => {
                const removed = await store.remove(path);
                return ok(removed ? `deleted: ${path}` : `already absent: ${path}`);
            }),
    );

    server.registerTool(
        "vault_search",
        {
            title: "Search vault notes",
            description:
                "Case insensitive substring search across notes. Returns matching paths with line numbers.",
            inputSchema: {
                query: z.string().min(1),
                subdir: z.string().default(""),
                limit: z.number().int().positive().max(500).default(100),
            },
        },
        ({ query, subdir, limit }) =>
            guarded(async () => {
                const needle = query.toLowerCase();
                const hits: string[] = [];
                for (const entry of await store.list(subdir)) {
                    const content = await store.read(entry.path);
                    if (content === null) continue;
                    const lines = content.split("\n");
                    for (let i = 0; i < lines.length; i++) {
                        const line = lines[i];
                        if (line === undefined) continue;
                        if (!line.toLowerCase().includes(needle)) continue;
                        hits.push(`${entry.path}:${i + 1}: ${line.trim()}`);
                        if (hits.length >= limit) {
                            return ok(hits.join("\n") + `\n\n(stopped at ${limit} matches)`);
                        }
                    }
                }
                return ok(hits.length === 0 ? "no matches" : hits.join("\n"));
            }),
    );

    server.registerTool(
        "jira_sync",
        {
            title: "Reconcile Jira tasks into the vault",
            description:
                "Re-query Jira and bring the synced task folder in line. Safe to call repeatedly; it is idempotent and leaves the vault untouched if Jira is unreachable.",
            inputSchema: {},
        },
        () =>
            guarded(async () => {
                if (syncRunner === null) return fail("jira sync is disabled");
                const result = await syncRunner.run();
                return ok(JSON.stringify(result));
            }),
    );

    if (watcher !== undefined) {
        server.registerTool(
            "config_reload",
            {
                title: "Reload the service configuration",
                description:
                    "Re-read the config file and apply what can be applied without a restart. Reports which settings took effect, which need a restart, and any validation error (in which case the previous config stays live).",
                inputSchema: {},
            },
            () => guarded(async () => ok(JSON.stringify(watcher.reload(), null, 2))),
        );
    }

    return server;
}

/**
 * Stateless transport: every request is self contained, so there is no session
 * map to leak and the container can restart without stranding clients.
 */
export function createMcpTransport(): StreamableHTTPServerTransport {
    return new StreamableHTTPServerTransport({});
}
