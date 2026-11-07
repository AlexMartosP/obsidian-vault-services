import { z } from "zod";
import fs from "node:fs";
import path from "node:path";

/**
 * Configuration comes from two places with a deliberate split:
 *
 *   config file  non-secret behaviour (JQL, where notes live, schedules)
 *   environment  secrets only, plus an override for any file value
 *
 * Precedence is defaults < config file < environment. Keeping the JQL and the
 * target folder in a mounted file means tuning them is an edit and a restart,
 * with no secrets in the same document.
 *
 * A feature is enabled by the presence of its *credentials*, never by the file.
 * A credential group that is only partly filled in is a startup error, so a
 * typo cannot silently turn a feature off.
 */

export class ConfigError extends Error {}

export const DEFAULT_JQL =
    "assignee = currentUser() " +
    "AND issuetype not in (Epic, Story) " +
    'AND status in ("In Progress", "In Review") ' +
    "ORDER BY updated DESC";

export const DEFAULT_CONFIG_FILE = "/config/vault-service.json";

const cronish = z.string().min(1);

/**
 * Shape of the on-disk config file. Every field is optional.
 *
 * Strict at every level, not just the top, so that a misspelling nested inside
 * `jira` or `backup` is reported rather than silently stripped and ignored.
 */
const fileSchema = z.strictObject({
    vaultDir: z.string().min(1).optional(),
    server: z.strictObject({ port: z.number().int().positive().optional() }).optional(),
    jira: z
        .strictObject({
            baseUrl: z.string().url().optional(),
            jql: z.string().min(1).optional(),
            targetSubdir: z.string().min(1).optional(),
            taskContext: z.string().min(1).optional(),
            reviewStatus: z.string().min(1).optional(),
            reconcileCron: cronish.optional(),
            webhookDebounceMs: z.number().int().positive().optional(),
        })
        .optional(),
    backup: z
        .strictObject({
            cron: cronish.optional(),
            bucket: z.string().min(1).optional(),
            endpoint: z.string().url().nullable().optional(),
            region: z.string().min(1).optional(),
            prefix: z.string().optional(),
            forcePathStyle: z.boolean().optional(),
        })
        .optional(),
    couchdb: z
        .strictObject({
            url: z.string().url().optional(),
            database: z.string().min(1).optional(),
        })
        .optional(),
});

export type FileConfig = z.infer<typeof fileSchema>;

export type JiraConfig = {
    baseUrl: string;
    email: string;
    apiToken: string;
    jql: string;
    targetSubdir: string;
    taskContext: string;
    reviewStatus: string;
    reconcileCron: string;
    webhookSecret: string | null;
    webhookDebounceMs: number;
};

export type CouchConfig = {
    url: string;
    database: string;
    user: string;
    password: string;
};

export type BackupConfig = {
    cron: string;
    bucket: string;
    endpoint: string | null;
    region: string;
    accessKeyId: string;
    secretAccessKey: string;
    prefix: string;
    forcePathStyle: boolean;
    /** The raw encrypted artifact is only possible when CouchDB is reachable. */
    couch: CouchConfig | null;
};

export type Config = {
    configFile: string | null;
    port: number;
    accessKey: string;
    vaultDir: string;
    jira: JiraConfig | null;
    backup: BackupConfig | null;
};

type Env = Record<string, string | undefined>;

function read(env: Env, key: string): string | undefined {
    const v = env[key];
    if (v === undefined) return undefined;
    const t = v.trim();
    return t === "" ? undefined : t;
}

function must(env: Env, key: string): string {
    const v = read(env, key);
    if (v === undefined) throw new ConfigError(`missing required environment variable ${key}`);
    return v;
}

function intFrom(env: Env, key: string, fromFile: number | undefined, fallback: number): number {
    const raw = read(env, key);
    if (raw === undefined) return fromFile ?? fallback;
    const n = Number(raw);
    if (!Number.isInteger(n) || n <= 0) {
        throw new ConfigError(`${key} must be a positive integer, got ${JSON.stringify(raw)}`);
    }
    return n;
}

function boolFrom(env: Env, key: string, fromFile: boolean | undefined, fallback: boolean): boolean {
    const raw = read(env, key)?.toLowerCase();
    if (raw === undefined) return fromFile ?? fallback;
    if (raw === "true" || raw === "1") return true;
    if (raw === "false" || raw === "0") return false;
    throw new ConfigError(`${key} must be true or false, got ${JSON.stringify(raw)}`);
}

/** env wins, then the config file, then the built-in default. */
function pick(env: Env, key: string, fromFile: string | undefined, fallback: string): string {
    return read(env, key) ?? fromFile ?? fallback;
}

/**
 * Resolve a credential group.
 * Returns false when none of `required` is set, throws when only some are.
 */
function credentialsPresent(env: Env, name: string, required: string[]): boolean {
    const present = required.filter((k) => read(env, k) !== undefined);
    if (present.length === 0) return false;
    const missing = required.filter((k) => read(env, k) === undefined);
    if (missing.length > 0) {
        throw new ConfigError(
            `${name} is partly configured. Present: ${present.join(", ")}. ` +
                `Missing: ${missing.join(", ")}. Set all of them, or none to disable ${name}.`,
        );
    }
    return true;
}

/**
 * JSON has no comments, so any key beginning with `//` is treated as one and
 * dropped before validation. Everything else stays strict, so a genuinely
 * misspelled setting is still reported rather than silently ignored.
 */
export function stripComments(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(stripComments);
    if (typeof value !== "object" || value === null) return value;
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
        if (key.startsWith("//")) continue;
        out[key] = stripComments(child);
    }
    return out;
}

export function loadFileConfig(filePath: string, required: boolean): FileConfig {
    if (!fs.existsSync(filePath)) {
        if (required) throw new ConfigError(`config file not found: ${filePath}`);
        return {};
    }
    let raw: string;
    try {
        raw = fs.readFileSync(filePath, "utf8");
    } catch (err) {
        throw new ConfigError(
            `could not read config file ${filePath}: ${err instanceof Error ? err.message : String(err)}`,
        );
    }
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch (err) {
        throw new ConfigError(
            `config file ${filePath} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
        );
    }
    const result = fileSchema.safeParse(stripComments(parsed));
    if (!result.success) {
        // `strict` means an unknown key is reported rather than ignored, so a
        // misspelled setting is visible instead of quietly having no effect.
        throw new ConfigError(`config file ${filePath} is invalid: ${result.error.message}`);
    }
    return result.data;
}

export function loadConfig(env: Env = process.env): Config {
    const explicitFile = read(env, "CONFIG_FILE");
    const configFile = explicitFile ?? DEFAULT_CONFIG_FILE;
    // An explicitly named file must exist; the default one is optional.
    const file = loadFileConfig(configFile, explicitFile !== undefined);
    const usedFile = fs.existsSync(configFile) ? path.resolve(configFile) : null;

    const vaultDir = read(env, "VAULT_DIR") ?? file.vaultDir ?? "/vault";
    if (!fs.existsSync(vaultDir) || !fs.statSync(vaultDir).isDirectory()) {
        throw new ConfigError(`vault directory is not an existing directory: ${vaultDir}`);
    }

    let jira: JiraConfig | null = null;
    if (credentialsPresent(env, "Jira sync", ["JIRA_EMAIL", "JIRA_API_TOKEN"])) {
        const f = file.jira ?? {};
        jira = {
            baseUrl: pick(env, "JIRA_BASE_URL", f.baseUrl, "https://minuthq.atlassian.net"),
            email: must(env, "JIRA_EMAIL"),
            apiToken: must(env, "JIRA_API_TOKEN"),
            jql: pick(env, "JIRA_JQL", f.jql, DEFAULT_JQL),
            targetSubdir: pick(env, "JIRA_TARGET_SUBDIR", f.targetSubdir, "Work/Jira"),
            taskContext: pick(env, "JIRA_TASK_CONTEXT", f.taskContext, "Work"),
            reviewStatus: pick(env, "JIRA_REVIEW_STATUS", f.reviewStatus, "in-progress"),
            reconcileCron: pick(env, "JIRA_RECONCILE_CRON", f.reconcileCron, "*/20 * * * *"),
            webhookSecret: read(env, "JIRA_WEBHOOK_SECRET") ?? null,
            webhookDebounceMs: intFrom(env, "JIRA_WEBHOOK_DEBOUNCE_MS", f.webhookDebounceMs, 2000),
        };
    }

    let couch: CouchConfig | null = null;
    if (credentialsPresent(env, "CouchDB raw export", ["COUCHDB_USER", "COUCHDB_PASSWORD"])) {
        const f = file.couchdb ?? {};
        const url = read(env, "COUCHDB_URL") ?? f.url;
        const database = read(env, "COUCHDB_DB") ?? f.database;
        if (url === undefined || database === undefined) {
            throw new ConfigError(
                "CouchDB raw export needs a url and database. Set couchdb.url and " +
                    "couchdb.database in the config file, or COUCHDB_URL and COUCHDB_DB.",
            );
        }
        couch = {
            url,
            database,
            user: must(env, "COUCHDB_USER"),
            password: must(env, "COUCHDB_PASSWORD"),
        };
    }

    let backup: BackupConfig | null = null;
    if (credentialsPresent(env, "S3 backup", ["S3_ACCESS_KEY_ID", "S3_SECRET_ACCESS_KEY"])) {
        const f = file.backup ?? {};
        const bucket = read(env, "S3_BUCKET") ?? f.bucket;
        if (bucket === undefined) {
            throw new ConfigError(
                "S3 backup needs a bucket. Set backup.bucket in the config file, or S3_BUCKET.",
            );
        }
        backup = {
            cron: pick(env, "BACKUP_CRON", f.cron, "0 3 * * *"),
            bucket,
            endpoint: read(env, "S3_ENDPOINT") ?? f.endpoint ?? null,
            region: pick(env, "S3_REGION", f.region, "auto"),
            accessKeyId: must(env, "S3_ACCESS_KEY_ID"),
            secretAccessKey: must(env, "S3_SECRET_ACCESS_KEY"),
            prefix: read(env, "S3_PREFIX") ?? f.prefix ?? "vault-backups",
            forcePathStyle: boolFrom(env, "S3_FORCE_PATH_STYLE", f.forcePathStyle, true),
            couch,
        };
    }

    return {
        configFile: usedFile,
        port: intFrom(env, "PORT", file.server?.port, 8080),
        accessKey: must(env, "ACCESS_KEY"),
        vaultDir,
        jira,
        backup,
    };
}
