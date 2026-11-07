import fs from "node:fs/promises";
import type { Dirent } from "node:fs";
import path from "node:path";
import { VaultPaths } from "./paths.ts";

export type VaultEntry = {
    path: string;
    size: number;
    modified: string;
};

/** Directories that are never part of the note content. */
const SKIP_DIRS = new Set([".obsidian", ".git", ".trash", "node_modules"]);

export function isNotFound(err: unknown): boolean {
    return (
        typeof err === "object" &&
        err !== null &&
        "code" in err &&
        (err as { code?: unknown }).code === "ENOENT"
    );
}

export class VaultStore {
    constructor(private readonly paths: VaultPaths) {}

    get root(): string {
        return this.paths.root;
    }

    async list(subdir = "", extension: string | null = ".md"): Promise<VaultEntry[]> {
        const start = this.paths.resolve(subdir);
        const out: VaultEntry[] = [];
        await this.walk(start, out, extension);
        out.sort((a, b) => a.path.localeCompare(b.path));
        return out;
    }

    private async walk(
        dir: string,
        out: VaultEntry[],
        extension: string | null,
    ): Promise<void> {
        let entries: Dirent[];
        try {
            entries = await fs.readdir(dir, { withFileTypes: true });
        } catch (err) {
            if (isNotFound(err)) return;
            throw err;
        }
        for (const entry of entries) {
            if (SKIP_DIRS.has(entry.name)) continue;
            if (entry.name.startsWith(".")) continue;
            const abs = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                await this.walk(abs, out, extension);
                continue;
            }
            if (!entry.isFile()) continue;
            if (extension !== null && !entry.name.endsWith(extension)) continue;
            const st = await fs.stat(abs);
            out.push({
                path: this.paths.relative(abs),
                size: st.size,
                modified: st.mtime.toISOString(),
            });
        }
    }

    async read(relPath: string): Promise<string | null> {
        try {
            return await fs.readFile(this.paths.resolve(relPath), "utf8");
        } catch (err) {
            if (isNotFound(err)) return null;
            throw err;
        }
    }

    /**
     * Write via a temp file in the same directory then rename. The rename is
     * atomic, so the livesync-bridge watcher never observes a half written
     * note. Temp names are dot prefixed so the bridge's ignore globs skip them.
     */
    async write(relPath: string, content: string): Promise<void> {
        const abs = this.paths.resolve(relPath);
        await fs.mkdir(path.dirname(abs), { recursive: true });
        const tmp = path.join(
            path.dirname(abs),
            `.${path.basename(abs)}.tmp-${process.pid}`,
        );
        await fs.writeFile(tmp, content, "utf8");
        await fs.rename(tmp, abs);
    }

    async remove(relPath: string): Promise<boolean> {
        try {
            await fs.unlink(this.paths.resolve(relPath));
            return true;
        } catch (err) {
            if (isNotFound(err)) return false;
            throw err;
        }
    }
}
