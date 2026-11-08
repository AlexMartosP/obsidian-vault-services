import { describe, expect, it, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { VaultPaths, PathOutsideVaultError, safeFilename } from "../src/vault/paths.ts";
import { VaultStore } from "../src/vault/store.ts";
import { JiraSync, type IssueSource } from "../src/jira/sync.ts";
import type { JiraIssue } from "../src/jira/client.ts";
import type { JiraConfig } from "../src/config.ts";
import { parseSyncOwnedNote } from "../src/vault/tasknotes.ts";

const SUBDIR = "Work/Jira";

function makeConfig(): JiraConfig {
    return {
        baseUrl: "https://minuthq.atlassian.net",
        email: "a@b.c",
        apiToken: "token",
        jql: "irrelevant",
        targetSubdir: SUBDIR,
        taskContext: "Work",
        statusMap: { "In Progress": "in-progress", "In Review": "in-progress" },
        defaultStatus: "in-progress",
        reconcileCron: "*/20 * * * *",
        webhookSecret: null,
        webhookDebounceMs: 2000,
    };
}

function issue(key: string, summary: string, status = "In Progress"): JiraIssue {
    return { key, summary, status, issueType: "Sub-task" };
}

class FakeJira implements IssueSource {
    constructor(
        public issues: JiraIssue[],
        public failWith: Error | null = null,
    ) {}
    async searchActive(): Promise<JiraIssue[]> {
        if (this.failWith !== null) throw this.failWith;
        return this.issues;
    }
}

let vaultDir: string;
let store: VaultStore;

beforeEach(async () => {
    vaultDir = await fs.mkdtemp(path.join(os.tmpdir(), "vault-test-"));
    await fs.mkdir(path.join(vaultDir, SUBDIR), { recursive: true });
    store = new VaultStore(new VaultPaths(vaultDir));
});

afterEach(async () => {
    await fs.rm(vaultDir, { recursive: true, force: true });
});

async function listNotes(): Promise<string[]> {
    const entries = await store.list(SUBDIR);
    return entries.map((e) => e.path).sort();
}

describe("path safety", () => {
    it("rejects traversal, absolute paths and sibling-prefix escapes", () => {
        const paths = new VaultPaths(vaultDir);
        expect(() => paths.resolve("../escape.md")).toThrow(PathOutsideVaultError);
        expect(() => paths.resolve("Work/../../escape.md")).toThrow(PathOutsideVaultError);
        expect(() => paths.resolve("/etc/passwd")).toThrow(PathOutsideVaultError);
        expect(() => paths.resolve("a/../../../b")).toThrow(PathOutsideVaultError);
    });

    it("allows ordinary nested paths, including spaces", () => {
        const paths = new VaultPaths(vaultDir);
        expect(() => paths.resolve("Work/Jira/TT-1 Some summary.md")).not.toThrow();
    });

    it("strips characters Obsidian and filesystems reject, keeps spaces", () => {
        expect(safeFilename("TT-1 a/b:c*d?e\"f<g>h|i#j^k[l]m")).toBe("TT-1 abcdefghijklm.md");
    });
});

describe("reconcile", () => {
    it("creates a note per active issue", async () => {
        const sync = new JiraSync(store, new FakeJira([issue("TT-1", "First"), issue("TT-2", "Second")]), makeConfig());
        const r = await sync.reconcile();
        expect(r).toMatchObject({ active: 2, added: 2, updated: 0, removed: 0 });
        expect(await listNotes()).toEqual([`${SUBDIR}/TT-1 First.md`, `${SUBDIR}/TT-2 Second.md`]);
    });

    it("includes the ticket link and the ownership marker", async () => {
        const sync = new JiraSync(store, new FakeJira([issue("TT-1", "First")]), makeConfig());
        await sync.reconcile();
        const body = await store.read(`${SUBDIR}/TT-1 First.md`);
        expect(body).not.toBeNull();
        expect(body).toContain("https://minuthq.atlassian.net/browse/TT-1");
        expect(parseSyncOwnedNote(body ?? "")).toMatchObject({ jiraKey: "TT-1" });
    });

    it("is idempotent, so a no-change run rewrites nothing", async () => {
        const fake = new FakeJira([issue("TT-1", "First")]);
        const sync = new JiraSync(store, fake, makeConfig());
        await sync.reconcile();

        const file = path.join(vaultDir, SUBDIR, "TT-1 First.md");
        const before = await fs.readFile(file, "utf8");
        const statBefore = await fs.stat(file);

        const second = await sync.reconcile();
        const after = await fs.readFile(file, "utf8");
        const statAfter = await fs.stat(file);

        expect(second).toMatchObject({ added: 0, updated: 0, removed: 0 });
        expect(after).toBe(before);
        expect(statAfter.mtimeMs).toBe(statBefore.mtimeMs);
    });

    it("deletes the note once the issue leaves the active set", async () => {
        const fake = new FakeJira([issue("TT-1", "First")]);
        const sync = new JiraSync(store, fake, makeConfig());
        await sync.reconcile();
        expect(await listNotes()).toHaveLength(1);

        fake.issues = [];
        const r = await sync.reconcile();
        expect(r).toMatchObject({ active: 0, removed: 1 });
        expect(await listNotes()).toEqual([]);
    });

    it("renames when the summary changes and preserves dateCreated", async () => {
        const fake = new FakeJira([issue("TT-1", "Old title")]);
        const sync = new JiraSync(store, fake, makeConfig());
        await sync.reconcile();
        const created = parseSyncOwnedNote(
            (await store.read(`${SUBDIR}/TT-1 Old title.md`)) ?? "",
        )?.dateCreated;
        expect(created).toBeTruthy();

        fake.issues = [issue("TT-1", "New title")];
        const r = await sync.reconcile();
        expect(r).toMatchObject({ updated: 1, removed: 0 });
        expect(await listNotes()).toEqual([`${SUBDIR}/TT-1 New title.md`]);
        const movedCreated = parseSyncOwnedNote(
            (await store.read(`${SUBDIR}/TT-1 New title.md`)) ?? "",
        )?.dateCreated;
        expect(movedCreated).toBe(created);
    });

    it("never touches notes it does not own", async () => {
        const handWritten = `${SUBDIR}/My own note.md`;
        await store.write(handWritten, "---\nstatus: open\ntags:\n  - task\n---\n\nmine\n");
        // A note that merely mentions jira in the body must also be left alone.
        const decoy = `${SUBDIR}/Decoy.md`;
        await store.write(decoy, "---\nstatus: open\n---\n\nsource: jira\njiraKey: TT-9\n");

        const sync = new JiraSync(store, new FakeJira([]), makeConfig());
        const r = await sync.reconcile();

        expect(r.removed).toBe(0);
        expect(await store.read(handWritten)).toContain("mine");
        expect(await store.read(decoy)).toContain("source: jira");
    });

    it("changes nothing when Jira fails", async () => {
        const fake = new FakeJira([issue("TT-1", "First")]);
        const sync = new JiraSync(store, fake, makeConfig());
        await sync.reconcile();
        const before = await listNotes();

        fake.failWith = new Error("network down");
        await expect(sync.reconcile()).rejects.toThrow("network down");
        expect(await listNotes()).toEqual(before);
    });

    it("prunes duplicate notes sharing one Jira key, keeping the first path", async () => {
        const sync = new JiraSync(store, new FakeJira([issue("TT-1", "First")]), makeConfig());
        await sync.reconcile();
        const original = (await store.read(`${SUBDIR}/TT-1 First.md`)) ?? "";
        await store.write(`${SUBDIR}/zz copy of TT-1.md`, original);

        const r = await sync.reconcile();
        expect(r.deduped).toBe(1);
        expect(await listNotes()).toEqual([`${SUBDIR}/TT-1 First.md`]);
    });

});

describe("status mapping", () => {
    async function bodyFor(
        statusMap: Record<string, string>,
        defaultStatus: string,
        jiraStatus: string,
    ): Promise<string> {
        const config = { ...makeConfig(), statusMap, defaultStatus };
        const sync = new JiraSync(
            store,
            new FakeJira([issue("TT-1", "Thing", jiraStatus)]),
            config,
        );
        await sync.reconcile();
        return (await store.read(`${SUBDIR}/TT-1 Thing.md`)) ?? "";
    }

    it("maps each Jira status to its configured TaskNotes status", async () => {
        const map = { "In Progress": "in-progress", "In Review": "in-review", Staging: "done" };
        expect(await bodyFor(map, "open", "In Review")).toContain("status: in-review");
    });

    it("keeps the real Jira status in the note regardless of the mapping", async () => {
        const body = await bodyFor({ "In Review": "in-progress" }, "open", "In Review");
        expect(body).toContain("status: in-progress");
        expect(body).toContain('jiraStatus: "In Review"');
    });

    it("falls back to defaultStatus for an unmapped status", async () => {
        expect(await bodyFor({ "In Progress": "in-progress" }, "open", "Blocked")).toContain(
            "status: open",
        );
    });

    it("looks up case insensitively, so casing drift in Jira does not break it", async () => {
        expect(await bodyFor({ "in progress": "in-progress" }, "open", "In Progress")).toContain(
            "status: in-progress",
        );
    });

    it("quotes a mapped value safely in the frontmatter", async () => {
        // A status containing a colon would break unquoted YAML.
        const body = await bodyFor({ "In Progress": "in-progress" }, "open", 'Odd: "status"');
        expect(body).toContain('jiraStatus: "Odd: \\"status\\""');
    });
});
