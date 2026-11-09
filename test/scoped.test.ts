import { describe, expect, it, beforeEach, afterEach } from "vitest";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { VaultPaths } from "../src/vault/paths.ts";
import { VaultStore } from "../src/vault/store.ts";
import { ScopedStore, PathOutsideScopeError } from "../src/vault/scoped.ts";

let dir: string;
let store: VaultStore;

beforeEach(async () => {
    dir = await fsp.mkdtemp(path.join(os.tmpdir(), "scope-"));
    store = new VaultStore(new VaultPaths(dir));
    await store.write("Work/task.md", "work note");
    await store.write("Work/sub/deep.md", "deep work");
    await store.write("Work2/other.md", "sibling prefix");
    await store.write("Personal/diary.md", "private");
    await store.write("top.md", "root level");
});

afterEach(async () => {
    await fsp.rm(dir, { recursive: true, force: true });
});

describe("a scoped key sees only its subtree", () => {
    it("lists only what is inside the scope, with scope-relative paths", async () => {
        const scoped = new ScopedStore(store, "Work");
        const paths = (await scoped.list()).map((e) => e.path).sort();
        // Note: no "Work/" prefix, and nothing from Work2 or Personal.
        expect(paths).toEqual(["sub/deep.md", "task.md"]);
    });

    it("reads inside the scope", async () => {
        const scoped = new ScopedStore(store, "Work");
        expect(await scoped.read("task.md")).toBe("work note");
        expect(await scoped.read("sub/deep.md")).toBe("deep work");
    });

    it("cannot read another folder by traversal", async () => {
        const scoped = new ScopedStore(store, "Work");
        for (const attempt of [
            "../Personal/diary.md",
            "../../Personal/diary.md",
            "sub/../../Personal/diary.md",
            "./../Personal/diary.md",
            "/Personal/diary.md",
        ]) {
            await expect(scoped.read(attempt)).rejects.toThrow(PathOutsideScopeError);
        }
    });

    it("cannot reach a sibling whose name starts with the scope", async () => {
        const scoped = new ScopedStore(store, "Work");
        // "Work2" must not pass the prefix check for "Work".
        await expect(scoped.read("../Work2/other.md")).rejects.toThrow(PathOutsideScopeError);
        expect((await scoped.list()).map((e) => e.path)).not.toContain("other.md");
    });

    it("cannot read the vault root", async () => {
        const scoped = new ScopedStore(store, "Work");
        await expect(scoped.read("../top.md")).rejects.toThrow(PathOutsideScopeError);
    });

    it("confines writes, so a scoped key cannot plant a file elsewhere", async () => {
        const scoped = new ScopedStore(store, "Work");
        await expect(scoped.write("../Personal/evil.md", "x")).rejects.toThrow(
            PathOutsideScopeError,
        );
        expect(await store.read("Personal/evil.md")).toBeNull();
    });

    it("confines deletes", async () => {
        const scoped = new ScopedStore(store, "Work");
        await expect(scoped.remove("../Personal/diary.md")).rejects.toThrow(
            PathOutsideScopeError,
        );
        expect(await store.read("Personal/diary.md")).toBe("private");
    });

    it("writes land in the right place and are visible to the root store", async () => {
        const scoped = new ScopedStore(store, "Work");
        await scoped.write("new.md", "created via scope");
        expect(await store.read("Work/new.md")).toBe("created via scope");
        expect(await scoped.read("new.md")).toBe("created via scope");
    });

    it("scopes to a nested folder", async () => {
        const scoped = new ScopedStore(store, "Work/sub");
        expect((await scoped.list()).map((e) => e.path)).toEqual(["deep.md"]);
        await expect(scoped.read("../task.md")).rejects.toThrow(PathOutsideScopeError);
    });

    it("tolerates surrounding slashes in the configured scope", async () => {
        for (const spelling of ["/Work/", "Work/", "/Work", "Work"]) {
            const scoped = new ScopedStore(store, spelling);
            expect((await scoped.list()).map((e) => e.path).sort()).toEqual([
                "sub/deep.md",
                "task.md",
            ]);
        }
    });

    it("rejects a scope that is itself an escape, at construction", () => {
        expect(() => new ScopedStore(store, "../elsewhere")).toThrow(PathOutsideScopeError);
    });
});

describe("an unscoped key behaves exactly as before", () => {
    it("sees the whole vault with unchanged paths", async () => {
        for (const spelling of ["", "  ", "/", "."]) {
            const scoped = new ScopedStore(store, spelling);
            const paths = (await scoped.list()).map((e) => e.path).sort();
            expect(paths).toEqual([
                "Personal/diary.md",
                "Work/sub/deep.md",
                "Work/task.md",
                "Work2/other.md",
                "top.md",
            ]);
        }
    });

    it("still cannot leave the vault", async () => {
        const scoped = new ScopedStore(store, "");
        await expect(scoped.read("../../etc/passwd")).rejects.toThrow();
    });
});
