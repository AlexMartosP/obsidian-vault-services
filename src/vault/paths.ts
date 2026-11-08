import path from "node:path";
import fs from "node:fs";

/**
 * The API and MCP tools expose file access behind nothing but a shared access
 * key, so every caller supplied path goes through here.
 *
 * Two layers, because the first is not sufficient on its own:
 *
 *  1. Textual. Reject absolute paths, NUL bytes, and anything resolving
 *     outside the vault root.
 *  2. Filesystem. Reject symlinks, and confirm the real path of the deepest
 *     existing ancestor is still inside the root. Without this, a symlink
 *     already present in the vault (Obsidian users do symlink attachment
 *     folders, and livesync-bridge could introduce one) resolves "inside"
 *     textually while fs.readFile and fs.writeFile follow it happily to a
 *     target outside the vault.
 */
export class PathOutsideVaultError extends Error {
    constructor(requested: string, reason = "escapes the vault") {
        super(`path ${reason}: ${requested}`);
    }
}

const NUL = "\u0000";

export class VaultPaths {
    readonly root: string;

    constructor(vaultDir: string) {
        this.root = fs.realpathSync(path.resolve(vaultDir));
    }

    /** Resolve a vault relative path to an absolute one inside the vault. */
    resolve(relPath: string): string {
        if (relPath.includes(NUL)) throw new PathOutsideVaultError(relPath);
        if (path.isAbsolute(relPath)) throw new PathOutsideVaultError(relPath);

        // Compare against root + separator so "/vaultX" cannot pass for "/vault".
        const abs = path.resolve(this.root, relPath);
        if (!this.isInside(abs)) throw new PathOutsideVaultError(relPath);

        this.assertNoSymlinkEscape(abs, relPath);
        return abs;
    }

    private isInside(abs: string): boolean {
        return abs === this.root || abs.startsWith(this.root + path.sep);
    }

    private assertNoSymlinkEscape(abs: string, relPath: string): void {
        // lstat rather than exists, so a dangling symlink is caught too:
        // writing through one would create the file at its outside target.
        let leaf: fs.Stats | null;
        try {
            leaf = fs.lstatSync(abs);
        } catch {
            leaf = null; // does not exist yet, which is fine for a new note
        }
        if (leaf !== null && leaf.isSymbolicLink()) {
            throw new PathOutsideVaultError(relPath, "is a symlink");
        }

        // A symlinked parent directory would take us out of the vault as well.
        let probe = leaf === null ? path.dirname(abs) : abs;
        for (;;) {
            try {
                if (!this.isInside(fs.realpathSync(probe))) {
                    throw new PathOutsideVaultError(
                        relPath,
                        "resolves outside the vault through a link",
                    );
                }
                return;
            } catch (err) {
                if (err instanceof PathOutsideVaultError) throw err;
                const parent = path.dirname(probe);
                if (parent === probe) return; // reached the filesystem root
                probe = parent;
            }
        }
    }

    /** Inverse of resolve, for reporting paths back to callers. */
    relative(absPath: string): string {
        return path.relative(this.root, absPath).split(path.sep).join("/");
    }
}

/**
 * Characters unsafe in a filename on macOS, Linux or Windows, plus Obsidian
 * link syntax, plus C0 and DEL control characters.
 *
 * Control characters matter for more than tidiness: a Jira summary containing
 * one would otherwise build a filename that `resolve` rejects outright, so
 * that issue would fail on every single run.
 */
const ILLEGAL_FILENAME = /[\\/:*?"<>|#^[\]\u0000-\u001f\u007f]/g;
const MAX_BASENAME = 110;

/** Turn arbitrary text into one safe path segment. */
export function safeFilename(text: string, extension = ".md"): string {
    let base = text.replace(ILLEGAL_FILENAME, "");
    base = base.replace(/\s+/g, " ").trim();
    base = base.replace(/^\.+/, "").replace(/[. ]+$/, "");
    if (base.length > MAX_BASENAME) {
        base = base.slice(0, MAX_BASENAME).replace(/[ .,;:-]+$/, "");
    }
    // Windows reserves these names regardless of extension.
    if (/^(con|prn|aux|nul|com\d|lpt\d)$/i.test(base)) base = `_${base}`;
    if (base === "") base = "untitled";
    return base + extension;
}
