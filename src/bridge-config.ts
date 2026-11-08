import { z } from "zod";

/**
 * Renders livesync-bridge's config.json from environment variables.
 *
 * The bridge reads credentials only from `dat/config.json`; it has no
 * environment support of its own. Writing that file by hand would mean the
 * CouchDB password and the vault E2EE passphrase sitting in plaintext on the
 * host filesystem, where they can be backed up, copied or committed by
 * accident.
 *
 * So the file is generated at container start from the environment, into a
 * tmpfs-backed volume. The secrets then live in the platform's own secret
 * store and in RAM, and never land on disk.
 */

export class BridgeConfigError extends Error {}

const envSchema = z.object({
    COUCHDB_URL: z.string().url(),
    COUCHDB_DB: z.string().min(1),
    COUCHDB_USER: z.string().min(1),
    COUCHDB_PASSWORD: z.string().min(1),
    VAULT_E2EE_PASSPHRASE: z.string().min(1),
    /**
     * Scope of the sync, as a vault relative folder with a trailing slash.
     * Defaults narrow on purpose: a wrong config then affects one folder
     * rather than the whole vault. Set to "" to sync everything.
     */
    BRIDGE_BASE_DIR: z.string().default("Work/Jira/"),
    BRIDGE_MINIMUM_CHUNK_SIZE: z.coerce.number().int().positive().default(20),
    BRIDGE_CUSTOM_CHUNK_SIZE: z.coerce.number().int().min(0).default(0),
});

export type BridgeConfig = {
    peers: unknown[];
};

/** Where the bridge's storage peer sees the vault, relative to /app. */
const STORAGE_ROOT = "./data/vault/";

function normaliseBaseDir(value: string): string {
    const trimmed = value.trim().replace(/^\/+/, "");
    if (trimmed === "") return "";
    return trimmed.endsWith("/") ? trimmed : `${trimmed}/`;
}

/**
 * Blank is treated as absent, so an unset platform variable cannot render an
 * empty password or passphrase.
 *
 * BRIDGE_BASE_DIR is excluded from that rule, because empty is a meaningful
 * value there: it means sync the whole vault. Folding it into the
 * blank-is-absent rule silently restored the narrow default instead, which is
 * the wrong direction to fail in, since the scope would be smaller than asked
 * for and nothing would say so.
 */
const EMPTY_IS_MEANINGFUL = new Set(["BRIDGE_BASE_DIR"]);

export function buildBridgeConfig(env: Record<string, string | undefined>): BridgeConfig {
    const present: Record<string, string> = {};
    for (const [key, value] of Object.entries(env)) {
        if (value === undefined) continue;
        if (value.trim() === "" && !EMPTY_IS_MEANINGFUL.has(key)) continue;
        present[key] = value;
    }

    const parsed = envSchema.safeParse(present);
    if (!parsed.success) {
        const missing = parsed.error.issues.map((i) => i.path.join(".")).join(", ");
        throw new BridgeConfigError(
            `cannot render the livesync-bridge config, these are missing or invalid: ${missing}`,
        );
    }
    const e = parsed.data;
    const baseDir = normaliseBaseDir(e.BRIDGE_BASE_DIR);

    return {
        peers: [
            {
                type: "couchdb",
                name: "couch",
                group: "vault",
                url: e.COUCHDB_URL.replace(/\/+$/, ""),
                database: e.COUCHDB_DB,
                username: e.COUCHDB_USER,
                password: e.COUCHDB_PASSWORD,
                // One passphrase covers both content and path obfuscation;
                // the plugin derives the obfuscation key from the same secret.
                passphrase: e.VAULT_E2EE_PASSPHRASE,
                obfuscatePassphrase: e.VAULT_E2EE_PASSPHRASE,
                baseDir,
                // Take encrypt / usePathObfuscation / E2EEAlgorithm from the
                // remote, so this cannot drift from the plugin's settings.
                useRemoteTweaks: true,
                customChunkSize: e.BRIDGE_CUSTOM_CHUNK_SIZE,
                minimumChunkSize: e.BRIDGE_MINIMUM_CHUNK_SIZE,
            },
            {
                type: "storage",
                name: "files",
                group: "vault",
                baseDir: `${STORAGE_ROOT}${baseDir}`,
                scanOfflineChanges: true,
                useChokidar: true,
                // The service writes notes atomically as a dot-prefixed temp
                // file then renames; the bridge must not try to sync those.
                ignore: [".*.tmp-*", "**/.*.tmp-*", "**/.obsidian/**", "**/.git/**"],
            },
        ],
    };
}

/** Same shape, with every secret replaced, for logging. */
export function redactBridgeConfig(config: BridgeConfig): string {
    return JSON.stringify(
        config,
        (key, value: unknown) =>
            key === "password" || key === "passphrase" || key === "obfuscatePassphrase"
                ? "<redacted>"
                : value,
        2,
    );
}
