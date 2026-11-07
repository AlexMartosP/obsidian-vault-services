import { z } from "zod";
import fs from "node:fs";

/**
 * Each feature is configured by its own group of variables. A group that is
 * entirely absent disables the feature; a group that is only partly filled in
 * is an error, so that a typo cannot silently turn a feature off.
 */

const jiraSchema = z.object({
    baseUrl: z.string().url(),
    email: z.string().min(1),
    apiToken: z.string().min(1),
    jql: z.string().min(1),
    targetSubdir: z.string().min(1),
    taskContext: z.string().min(1),
    reviewStatus: z.string().min(1),
    reconcileCron: z.string().min(1),
    webhookSecret: z.string().min(1).nullable(),
    webhookDebounceMs: z.number().int().positive(),
});
export type JiraConfig = z.infer<typeof jiraSchema>;

const couchSchema = z.object({
    url: z.string().url(),
    database: z.string().min(1),
    user: z.string().min(1),
    password: z.string().min(1),
});
export type CouchConfig = z.infer<typeof couchSchema>;

const backupSchema = z.object({
    cron: z.string().min(1),
    bucket: z.string().min(1),
    endpoint: z.string().url().nullable(),
    region: z.string().min(1),
    accessKeyId: z.string().min(1),
    secretAccessKey: z.string().min(1),
    prefix: z.string(),
    forcePathStyle: z.boolean(),
    /** Raw encrypted CouchDB export is only possible when CouchDB is reachable. */
    couch: couchSchema.nullable(),
});
export type BackupConfig = z.infer<typeof backupSchema>;

export type Config = {
    port: number;
    accessKey: string;
    vaultDir: string;
    jira: JiraConfig | null;
    backup: BackupConfig | null;
};

export const DEFAULT_JQL =
    "assignee = currentUser() " +
    "AND issuetype not in (Epic, Story) " +
    'AND status in ("In Progress", "In Review") ' +
    "ORDER BY updated DESC";

type Env = Record<string, string | undefined>;

function read(env: Env, key: string): string | undefined {
    const v = env[key];
    if (v === undefined) return undefined;
    const t = v.trim();
    return t === "" ? undefined : t;
}

class ConfigError extends Error {}

/**
 * Resolve an optional feature group.
 * Returns null when none of `required` is present, throws when some are.
 */
function group<T>(
    env: Env,
    name: string,
    required: string[],
    build: () => T,
): T | null {
    const present = required.filter((k) => read(env, k) !== undefined);
    if (present.length === 0) return null;
    const missing = required.filter((k) => read(env, k) === undefined);
    if (missing.length > 0) {
        throw new ConfigError(
            `${name} is partly configured. Present: ${present.join(", ")}. ` +
                `Missing: ${missing.join(", ")}. Set all of them, or none to disable ${name}.`,
        );
    }
    return build();
}

/** `required` here means required for the service to start at all. */
function must(env: Env, key: string): string {
    const v = read(env, key);
    if (v === undefined) throw new ConfigError(`missing required environment variable ${key}`);
    return v;
}

function intOr(env: Env, key: string, fallback: number): number {
    const raw = read(env, key);
    if (raw === undefined) return fallback;
    const n = Number(raw);
    if (!Number.isInteger(n) || n <= 0) {
        throw new ConfigError(`${key} must be a positive integer, got ${JSON.stringify(raw)}`);
    }
    return n;
}

function boolOr(env: Env, key: string, fallback: boolean): boolean {
    const raw = read(env, key)?.toLowerCase();
    if (raw === undefined) return fallback;
    if (raw === "true" || raw === "1") return true;
    if (raw === "false" || raw === "0") return false;
    throw new ConfigError(`${key} must be true or false, got ${JSON.stringify(raw)}`);
}

export function loadConfig(env: Env = process.env): Config {
    const vaultDir = must(env, "VAULT_DIR");
    if (!fs.existsSync(vaultDir) || !fs.statSync(vaultDir).isDirectory()) {
        throw new ConfigError(`VAULT_DIR is not an existing directory: ${vaultDir}`);
    }

    const jira = group(env, "Jira sync", ["JIRA_EMAIL", "JIRA_API_TOKEN"], () =>
        jiraSchema.parse({
            baseUrl: read(env, "JIRA_BASE_URL") ?? "https://minuthq.atlassian.net",
            email: must(env, "JIRA_EMAIL"),
            apiToken: must(env, "JIRA_API_TOKEN"),
            jql: read(env, "JIRA_JQL") ?? DEFAULT_JQL,
            targetSubdir: read(env, "JIRA_TARGET_SUBDIR") ?? "Work/Jira",
            taskContext: read(env, "JIRA_TASK_CONTEXT") ?? "Work",
            reviewStatus: read(env, "JIRA_REVIEW_STATUS") ?? "in-progress",
            reconcileCron: read(env, "JIRA_RECONCILE_CRON") ?? "*/20 * * * *",
            webhookSecret: read(env, "JIRA_WEBHOOK_SECRET") ?? null,
            webhookDebounceMs: intOr(env, "JIRA_WEBHOOK_DEBOUNCE_MS", 2000),
        }),
    );

    const couch = group(
        env,
        "CouchDB raw export",
        ["COUCHDB_URL", "COUCHDB_DB", "COUCHDB_USER", "COUCHDB_PASSWORD"],
        () =>
            couchSchema.parse({
                url: must(env, "COUCHDB_URL"),
                database: must(env, "COUCHDB_DB"),
                user: must(env, "COUCHDB_USER"),
                password: must(env, "COUCHDB_PASSWORD"),
            }),
    );

    const backup = group(
        env,
        "S3 backup",
        ["S3_BUCKET", "S3_ACCESS_KEY_ID", "S3_SECRET_ACCESS_KEY"],
        () =>
            backupSchema.parse({
                cron: read(env, "BACKUP_CRON") ?? "0 3 * * *",
                bucket: must(env, "S3_BUCKET"),
                endpoint: read(env, "S3_ENDPOINT") ?? null,
                region: read(env, "S3_REGION") ?? "auto",
                accessKeyId: must(env, "S3_ACCESS_KEY_ID"),
                secretAccessKey: must(env, "S3_SECRET_ACCESS_KEY"),
                prefix: read(env, "S3_PREFIX") ?? "vault-backups",
                forcePathStyle: boolOr(env, "S3_FORCE_PATH_STYLE", true),
                couch,
            }),
    );

    return {
        port: intOr(env, "PORT", 8080),
        accessKey: must(env, "ACCESS_KEY"),
        vaultDir,
        jira,
        backup,
    };
}

export { ConfigError };
