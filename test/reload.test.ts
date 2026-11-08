import { describe, expect, it, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { loadConfig, type Config } from "../src/config.ts";
import { Runtime, type Scheduler, type ScheduledHandle } from "../src/runtime.ts";
import { ConfigWatcher } from "../src/config-watch.ts";
import { VaultPaths } from "../src/vault/paths.ts";
import { VaultStore } from "../src/vault/store.ts";

let dir: string;
let vaultDir: string;
let configFile: string;
let store: VaultStore;

/** Records schedules instead of registering real timers. */
class FakeScheduler implements Scheduler {
    scheduled: string[] = [];
    stopped = 0;
    validate(expression: string): boolean {
        return /^[\d*/, -]+$/.test(expression);
    }
    schedule(expression: string): ScheduledHandle {
        this.scheduled.push(expression);
        return {
            stop: () => {
                this.stopped++;
            },
        };
    }
}

function writeConfig(value: unknown): void {
    fs.writeFileSync(configFile, JSON.stringify(value, null, 2));
}

/** Only secrets in the environment, everything else from the file. */
function load(): Config {
    return loadConfig({
        ACCESS_KEY: "key",
        CONFIG_FILE: configFile,
        JIRA_EMAIL: "a@b.c",
        JIRA_API_TOKEN: "t",
        JIRA_BASE_URL: "https://example.atlassian.net",
    });
}

/** Always carries vaultDir, since the environment no longer supplies it. */
function writeConfigWithVault(jira: Record<string, unknown>, extra: Record<string, unknown> = {}): void {
    writeConfig({ vaultDir, jira, ...extra });
}

beforeEach(async () => {
    dir = await fsp.mkdtemp(path.join(os.tmpdir(), "vs-reload-"));
    vaultDir = path.join(dir, "vault");
    await fsp.mkdir(vaultDir, { recursive: true });
    configFile = path.join(dir, "vault-service.json");
    store = new VaultStore(new VaultPaths(vaultDir));
    writeConfigWithVault({ jql: "ORIGINAL" });
});

afterEach(async () => {
    await fsp.rm(dir, { recursive: true, force: true });
});

describe("runtime config reload", () => {
    it("applies a changed query and reports which setting moved", () => {
        const runtime = new Runtime(load(), store, new FakeScheduler());
        expect(runtime.config.jira?.jql).toBe("ORIGINAL");

        writeConfigWithVault({ jql: "CHANGED" });
        const outcome = runtime.apply(load());

        expect(outcome).toMatchObject({ applied: ["jira.jql"], ignored: [], error: null });
        expect(runtime.config.jira?.jql).toBe("CHANGED");
    });

    it("reports no change when the file is rewritten identically", () => {
        const runtime = new Runtime(load(), store, new FakeScheduler());
        expect(runtime.apply(load())).toMatchObject({ applied: [], ignored: [] });
    });

    it("refuses to pretend a port change took effect", () => {
        const runtime = new Runtime(load(), store, new FakeScheduler());
        const before = runtime.config.port;

        writeConfigWithVault({ jql: "ORIGINAL" }, { server: { port: 9999 } });
        const outcome = runtime.apply(load());

        expect(outcome.ignored).toContain("server.port");
        expect(outcome.applied).toEqual([]);
        // The live config must keep claiming the port actually bound.
        expect(runtime.config.port).toBe(before);
    });

    it("keeps the vault directory the process started with", () => {
        const runtime = new Runtime(load(), store, new FakeScheduler());
        const other = path.join(dir, "elsewhere");
        fs.mkdirSync(other);
        writeConfig({ vaultDir: other, jira: { jql: "ORIGINAL" } });
        // The file now points elsewhere, but the store is already built.

        const outcome = runtime.apply(load());
        expect(outcome.ignored).toContain("vaultDir");
        expect(runtime.config.vaultDir).toBe(vaultDir);
    });

    it("reschedules the cron when its expression changes", () => {
        const scheduler = new FakeScheduler();
        const runtime = new Runtime(load(), store, scheduler);
        runtime.start();
        expect(scheduler.scheduled).toEqual(["*/20 * * * *"]);

        writeConfigWithVault({ jql: "ORIGINAL", reconcileCron: "*/5 * * * *" });
        runtime.apply(load());
        expect(scheduler.scheduled).toEqual(["*/20 * * * *", "*/5 * * * *"]);
        expect(scheduler.stopped).toBeGreaterThan(0);
    });

    it("keeps the old schedule when a new cron expression is invalid", () => {
        const scheduler = new FakeScheduler();
        const runtime = new Runtime(load(), store, scheduler);
        runtime.start();

        writeConfigWithVault({ jql: "ORIGINAL", reconcileCron: "not a cron" });
        runtime.apply(load());
        // Rejected, so nothing new was registered.
        expect(scheduler.scheduled).toEqual(["*/20 * * * *"]);
    });
});

describe("config watcher", () => {
    it("keeps the previous config when the file becomes invalid", () => {
        const runtime = new Runtime(load(), store, new FakeScheduler());
        const watcher = new ConfigWatcher(configFile, runtime, 1000, load);

        fs.writeFileSync(configFile, "{ broken");
        const outcome = watcher.reload();

        expect(outcome.error).toMatch(/not valid JSON/);
        expect(outcome.applied).toEqual([]);
        // Still serving what it had before the bad edit.
        expect(runtime.config.jira?.jql).toBe("ORIGINAL");
        expect(watcher.status.lastError).toMatch(/not valid JSON/);
    });

    it("recovers once the file is valid again", () => {
        const runtime = new Runtime(load(), store, new FakeScheduler());
        const watcher = new ConfigWatcher(configFile, runtime, 1000, load);

        fs.writeFileSync(configFile, "{ broken");
        expect(watcher.reload().error).not.toBeNull();

        writeConfigWithVault({ jql: "RECOVERED" });
        const outcome = watcher.reload();

        expect(outcome.error).toBeNull();
        expect(outcome.applied).toEqual(["jira.jql"]);
        expect(runtime.config.jira?.jql).toBe("RECOVERED");
        expect(watcher.status.lastError).toBeNull();
    });

    it("rejects a config whose required values went missing", () => {
        const runtime = new Runtime(load(), store, new FakeScheduler());
        const watcher = new ConfigWatcher(configFile, runtime, 1000, load);

        // Valid JSON, but an unknown key, which the strict schema rejects.
        writeConfig({ vaultDir, jira: { jqlTypo: "oops" } });
        expect(watcher.reload().error).toMatch(/invalid/);
        expect(runtime.config.jira?.jql).toBe("ORIGINAL");
    });

    it("reports where it is watching and how often", () => {
        const runtime = new Runtime(load(), store, new FakeScheduler());
        const watcher = new ConfigWatcher(configFile, runtime, 2500, load);
        expect(watcher.status).toMatchObject({ path: configFile, intervalMs: 2500, watching: false });
        watcher.start();
        expect(watcher.status.watching).toBe(true);
        watcher.stop();
        expect(watcher.status.watching).toBe(false);
    });
});
