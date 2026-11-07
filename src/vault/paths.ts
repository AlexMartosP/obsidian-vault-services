import path from "node:path";
import fs from "node:fs";

/**
 * The API exposes file access behind nothing but an access key, so every
 * caller supplied path goes through here. Rejects absolute paths, traversal
 * and NUL bytes, and resolves the vault root through realpath so a symlinked
 * root still compares correctly.
 */
export class PathOutsideVaultError extends Error {
    constructor(requested: string) {
        super(`path escapes the vault: ${requested}`);
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

        const abs = path.resolve(this.root, relPath);
        // Compare against root + separator so "/vaultX" cannot pass for "/vault".
        if (abs !== this.root && !abs.startsWith(this.root + path.sep)) {
            throw new PathOutsideVaultError(relPath);
        }
        return abs;
    }

    /** Inverse of resolve, for reporting paths back to callers. */
    relative(absPath: string): string {
        return path.relative(this.root, absPath).split(path.sep).join("/");
    }
}

/** Characters unsafe in a filename on macOS, Linux or Windows, plus Obsidian specials. */
const ILLEGAL_FILENAME = /[\\/:*?"<>|#^[\]]/g;
const MAX_BASENAME = 110;

/** Turn arbitrary text into one safe path segment. */
export function safeFilename(text: string, extension = ".md"): string {
    let base = text.replace(ILLEGAL_FILENAME, "");
    base = base.replace(/\s+/g, " ").trim();
    base = base.replace(/^\.+/, "").replace(/[. ]+$/, "");
    if (base.length > MAX_BASENAME) {
        base = base.slice(0, MAX_BASENAME).replace(/[ .,;:-]+$/, "");
    }
    if (base === "") base = "untitled";
    return base + extension;
}
