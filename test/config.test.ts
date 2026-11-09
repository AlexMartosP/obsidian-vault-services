import { describe, expect, it, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { loadConfig, ConfigError, DEFAULT_JQL, stripComments } from "../src/config.ts";

let dir: string;
let vaultDir: string;
let configFile: string;

beforeEach(async () => {
    dir = await fsp.mkdtemp(path.join(os.tmpdir(), "vs-config-"));
    vaultDir = path.join(dir, "vault");
    await fsp.mkdir(vaultDir, { recursive: true });
    configFile = path.join(dir, "vault-service.json");
});

afterEach(async () => {
    await fsp.rm(dir, { recursive: true, force: true });
});

function writeConfig(value: unknown): void {
    fs.writeFileSync(configFile, JSON.stringify(value, null, 2));
}

/** Only what the service needs to boot at all. */
function baseEnv(extra: Record<string, string> = {}): Record<string, string> {
    return {
        ACCESS_KEY: "key",
        VAULT_DIR: vaultDir,
        CONFIG_FILE: configFile,
        JIRA_BASE_URL: "https://example.atlassian.net",
        ...extra,
    };
}

describe("config file", () => {
    it("reads jql and target folder from the file", () => {
        writeConfig({
            jira: { jql: "project = TT AND status = Blocked", targetSubdir: "Work/Tickets" },
        });
        const config = loadConfig(baseEnv({ JIRA_EMAIL: "a@b.c", JIRA_API_TOKEN: "t" }));
        expect(config.jira?.jql).toBe("project = TT AND status = Blocked");
        expect(config.jira?.targetSubdir).toBe("Work/Tickets");
    });

    it("falls back to defaults when the file omits a value", () => {
        writeConfig({ jira: { targetSubdir: "Elsewhere" } });
        const config = loadConfig(baseEnv({ JIRA_EMAIL: "a@b.c", JIRA_API_TOKEN: "t" }));
        expect(config.jira?.jql).toBe(DEFAULT_JQL);
        expect(config.jira?.targetSubdir).toBe("Elsewhere");
    });

    it("lets the environment override the file", () => {
        writeConfig({ jira: { jql: "from file", targetSubdir: "from/file" } });
        const config = loadConfig(
            baseEnv({
                JIRA_EMAIL: "a@b.c",
                JIRA_API_TOKEN: "t",
                JIRA_JQL: "from env",
                JIRA_TARGET_SUBDIR: "from/env",
            }),
        );
        expect(config.jira?.jql).toBe("from env");
        expect(config.jira?.targetSubdir).toBe("from/env");
    });

    it("ignores // comment keys but still rejects a misspelled setting", () => {
        writeConfig({
            "//jira": "this is a note to self",
            jira: { "//jql": ["explanation", "spanning lines"], jql: "real value" },
        });
        expect(
            loadConfig(baseEnv({ JIRA_EMAIL: "a@b.c", JIRA_API_TOKEN: "t" })).jira?.jql,
        ).toBe("real value");

        writeConfig({ jira: { jqlTypo: "oops" } });
        expect(() => loadConfig(baseEnv())).toThrow(ConfigError);
    });

    it("requires a Jira base URL rather than defaulting to someone's host", () => {
        writeConfig({});
        expect(() =>
            loadConfig({
                ACCESS_KEY: "key",
                VAULT_DIR: vaultDir,
                CONFIG_FILE: configFile,
                JIRA_EMAIL: "a@b.c",
                JIRA_API_TOKEN: "t",
            }),
        ).toThrow(/needs a base URL/);
    });

    it("takes the Jira base URL from the config file and trims a trailing slash", () => {
        writeConfig({ jira: { baseUrl: "https://acme.atlassian.net/" } });
        const config = loadConfig({
            ACCESS_KEY: "key",
            VAULT_DIR: vaultDir,
            CONFIG_FILE: configFile,
            JIRA_EMAIL: "a@b.c",
            JIRA_API_TOKEN: "t",
        });
        expect(config.jira?.baseUrl).toBe("https://acme.atlassian.net");
    });

    it("errors when an explicitly named config file is missing", () => {
        expect(() =>
            loadConfig({ ACCESS_KEY: "key", VAULT_DIR: vaultDir, CONFIG_FILE: path.join(dir, "nope.json") }),
        ).toThrow(ConfigError);
    });

    it("starts without any config file when none is named", () => {
        const config = loadConfig({ ACCESS_KEY: "key", VAULT_DIR: vaultDir });
        expect(config.configFile).toBeNull();
        expect(config.jira).toBeNull();
        expect(config.backup).toBeNull();
    });

    it("rejects invalid JSON rather than starting with surprising defaults", () => {
        fs.writeFileSync(configFile, "{ not json");
        expect(() => loadConfig(baseEnv())).toThrow(ConfigError);
    });
});

describe("feature enablement", () => {
    it("is driven by credentials, not by the config file", () => {
        writeConfig({ jira: { jql: "x" }, backup: { bucket: "b" } });
        const config = loadConfig(baseEnv());
        expect(config.jira).toBeNull();
        expect(config.backup).toBeNull();
    });

    it("fails loudly when a credential group is only partly set", () => {
        writeConfig({});
        expect(() => loadConfig(baseEnv({ JIRA_EMAIL: "a@b.c" }))).toThrow(/partly configured/);
        expect(() => loadConfig(baseEnv({ S3_ACCESS_KEY_ID: "k" }))).toThrow(/partly configured/);
    });

    it("needs a bucket from somewhere once S3 credentials are present", () => {
        writeConfig({});
        expect(() =>
            loadConfig(baseEnv({ S3_ACCESS_KEY_ID: "k", S3_SECRET_ACCESS_KEY: "s" })),
        ).toThrow(/needs a bucket/);
    });

    it("takes the bucket and endpoint from the config file", () => {
        writeConfig({ backup: { bucket: "vault-bk", endpoint: "https://acct.r2.cloudflarestorage.com" } });
        const config = loadConfig(baseEnv({ S3_ACCESS_KEY_ID: "k", S3_SECRET_ACCESS_KEY: "s" }));
        expect(config.backup?.bucket).toBe("vault-bk");
        expect(config.backup?.endpoint).toBe("https://acct.r2.cloudflarestorage.com");
        // No CouchDB credentials, so only the plaintext artifact is possible.
        expect(config.backup?.couch).toBeNull();
    });

    it("enables the encrypted artifact only with CouchDB credentials and location", () => {
        writeConfig({ backup: { bucket: "b" }, couchdb: { url: "http://couchdb:5984", database: "vault" } });
        const config = loadConfig(
            baseEnv({
                S3_ACCESS_KEY_ID: "k",
                S3_SECRET_ACCESS_KEY: "s",
                COUCHDB_USER: "admin",
                COUCHDB_PASSWORD: "pw",
            }),
        );
        expect(config.backup?.couch).toMatchObject({ url: "http://couchdb:5984", database: "vault" });
    });

    it("refuses a vault directory that does not exist", () => {
        writeConfig({});
        expect(() =>
            loadConfig({ ACCESS_KEY: "key", VAULT_DIR: path.join(dir, "missing"), CONFIG_FILE: configFile }),
        ).toThrow(/not an existing directory/);
    });
});

describe("stripComments", () => {
    it("drops // keys at every depth and leaves everything else intact", () => {
        expect(
            stripComments({ "//a": 1, b: { "//c": 2, d: [{ "//e": 3, f: 4 }] } }),
        ).toEqual({ b: { d: [{ f: 4 }] } });
    });
});

describe("port resolution", () => {
    it("defaults to 8080 when nothing says otherwise", () => {
        writeConfig({});
        expect(loadConfig(baseEnv()).port).toBe(8080);
    });

    it("takes the port from the config file", () => {
        writeConfig({ server: { port: 9001 } });
        expect(loadConfig(baseEnv()).port).toBe(9001);
    });

    it("lets PORT in the environment win, which is what Docker relies on", () => {
        writeConfig({ server: { port: 9001 } });
        expect(loadConfig(baseEnv({ PORT: "8181" })).port).toBe(8181);
    });

    it("rejects a nonsense PORT instead of silently falling back", () => {
        writeConfig({});
        expect(() => loadConfig(baseEnv({ PORT: "0" }))).toThrow(ConfigError);
        expect(() => loadConfig(baseEnv({ PORT: "not-a-port" }))).toThrow(ConfigError);
    });
});

describe("public vault API", () => {
    it("is off unless both the port and its own key are set", () => {
        writeConfig({});
        expect(loadConfig(baseEnv()).publicApi).toBeNull();
    });

    it("fails loudly when only one of the pair is set", () => {
        writeConfig({});
        expect(() => loadConfig(baseEnv({ PUBLIC_PORT: "8081" }))).toThrow(/partly configured/);
        expect(() => loadConfig(baseEnv({ PUBLIC_ACCESS_KEY: "k" }))).toThrow(/partly configured/);
    });

    it("uses a key distinct from the admin key", () => {
        writeConfig({});
        const config = loadConfig(
            baseEnv({ PUBLIC_PORT: "8081", PUBLIC_ACCESS_KEY: "public-only" }),
        );
        expect(config.publicApi).toMatchObject({ port: 8081, accessKey: "public-only" });
        // The whole point: exposing one must not expose the other.
        expect(config.publicApi?.accessKey).not.toBe(config.accessKey);
    });

    it("rejects a nonsense public port", () => {
        writeConfig({});
        expect(() =>
            loadConfig(baseEnv({ PUBLIC_PORT: "0", PUBLIC_ACCESS_KEY: "k" })),
        ).toThrow(ConfigError);
    });
});
