import { describe, expect, it } from "vitest";
import {
    buildBridgeConfig,
    redactBridgeConfig,
    BridgeConfigError,
} from "../src/bridge-config.ts";

const base = {
    COUCHDB_URL: "https://couchdb.example.com",
    COUCHDB_DB: "vault",
    COUCHDB_USER: "admin",
    COUCHDB_PASSWORD: "pw",
    VAULT_E2EE_PASSPHRASE: "secret",
};

type Peer = Record<string, unknown>;
function peers(env: Record<string, string | undefined>): [Peer, Peer] {
    const built = buildBridgeConfig(env).peers as Peer[];
    const [couch, storage] = built;
    if (couch === undefined || storage === undefined) throw new Error("expected two peers");
    return [couch, storage];
}

describe("bridge config rendering", () => {
    it("uses one passphrase for content and for path obfuscation", () => {
        const [couch] = peers(base);
        expect(couch.passphrase).toBe("secret");
        expect(couch.obfuscatePassphrase).toBe("secret");
    });

    it("takes E2EE settings from the remote rather than restating them", () => {
        const [couch] = peers(base);
        expect(couch.useRemoteTweaks).toBe(true);
    });

    it("scopes narrowly by default, so a mistake cannot reach the whole vault", () => {
        const [couch, storage] = peers(base);
        expect(couch.baseDir).toBe("Work/Jira/");
        expect(storage.baseDir).toBe("./data/vault/Work/Jira/");
    });

    it("keeps the two peers' scopes in step when the base dir changes", () => {
        const [couch, storage] = peers({ ...base, BRIDGE_BASE_DIR: "Notes/Sub" });
        expect(couch.baseDir).toBe("Notes/Sub/");
        expect(storage.baseDir).toBe("./data/vault/Notes/Sub/");
    });

    it("supports syncing the whole vault with an empty base dir", () => {
        const [couch, storage] = peers({ ...base, BRIDGE_BASE_DIR: "" });
        expect(couch.baseDir).toBe("");
        expect(storage.baseDir).toBe("./data/vault/");
    });

    it("strips a trailing slash from the CouchDB url", () => {
        const [couch] = peers({ ...base, COUCHDB_URL: "https://couchdb.example.com/" });
        expect(couch.url).toBe("https://couchdb.example.com");
    });

    it("ignores the service's atomic write temp files", () => {
        const [, storage] = peers(base);
        expect(storage.ignore).toContain(".*.tmp-*");
        expect(storage.ignore).toContain("**/.*.tmp-*");
    });

    it("refuses to render without a passphrase, naming what is missing", () => {
        const { VAULT_E2EE_PASSPHRASE: _omitted, ...without } = base;
        expect(() => buildBridgeConfig(without)).toThrow(BridgeConfigError);
        expect(() => buildBridgeConfig(without)).toThrow(/VAULT_E2EE_PASSPHRASE/);
    });

    it("treats a blank value as absent rather than rendering an empty secret", () => {
        expect(() => buildBridgeConfig({ ...base, COUCHDB_PASSWORD: "   " })).toThrow(
            /COUCHDB_PASSWORD/,
        );
    });

    it("rejects a url that is not a url", () => {
        expect(() => buildBridgeConfig({ ...base, COUCHDB_URL: "couchdb" })).toThrow(
            /COUCHDB_URL/,
        );
    });

    it("never puts a secret in the redacted form used for logs", () => {
        const redacted = redactBridgeConfig(buildBridgeConfig(base));
        expect(redacted).not.toContain("secret");
        expect(redacted).not.toContain("pw");
        expect(redacted).toContain("<redacted>");
        // Non-secret fields must survive, or the log is useless.
        expect(redacted).toContain("https://couchdb.example.com");
        expect(redacted).toContain("Work/Jira/");
    });
});
