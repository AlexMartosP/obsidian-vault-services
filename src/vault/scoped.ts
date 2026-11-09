import path from "node:path";
import { PathOutsideVaultError } from "./paths.ts";
import type { VaultEntry, VaultStore } from "./store.ts";

/**
 * The subset of the store the note routes and MCP tools need, so a scoped
 * view can stand in for the real one everywhere.
 */
export type NoteStore = {
    readonly root: string;
    list(subdir?: string, extension?: string | null): Promise<VaultEntry[]>;
    read(relPath: string): Promise<string | null>;
    write(relPath: string, content: string): Promise<void>;
    remove(relPath: string): Promise<boolean>;
};

export class PathOutsideScopeError extends Error {
    constructor(requested: string, scope: string) {
        super(`path escapes the scope ${JSON.stringify(scope)}: ${requested}`);
    }
}

/**
 * A view of the vault confined to one subdirectory.
 *
 * Each public access key is bound to one of these, so a key issued for
 * `Work` cannot read `Personal` however the path is spelled. Confinement is
 * enforced twice over, because one layer is not enough:
 *
 *  1. The caller's path is joined onto the scope and normalised, then checked
 *     to still be inside the scope. This is what stops `../` and absolute
 *     paths, including the sibling-prefix case where `Work2` must not pass
 *     for `Work`.
 *  2. The underlying VaultStore still applies its own vault-root and symlink
 *     checks, so a scope cannot be used to reach outside the vault either.
 *
 * Paths cross the boundary scope-relative in both directions. A client never
 * sees or needs to know its prefix, which also means a key's scope can be
 * narrowed later without the client noticing.
 */
export class ScopedStore implements NoteStore {
    /** Normalised, no leading or trailing slash. Empty means the whole vault. */
    private readonly scope: string;

    constructor(
        private readonly inner: VaultStore,
        scope: string,
    ) {
        const cleaned = scope.trim().replace(/^\/+|\/+$/g, "");
        if (cleaned === "" || cleaned === ".") {
            this.scope = "";
            return;
        }
        // Reject a scope that is itself an escape, at construction rather than
        // on first use, so a bad config fails at startup.
        const resolved = path.posix.normalize(cleaned);
        if (resolved.startsWith("..") || path.isAbsolute(resolved)) {
            throw new PathOutsideScopeError(scope, scope);
        }
        this.scope = resolved.replace(/\/+$/, "");
    }

    get root(): string {
        return this.scope === "" ? this.inner.root : path.join(this.inner.root, this.scope);
    }

    /** scope-relative -> vault-relative, refusing anything that leaves the scope. */
    private toVaultPath(relPath: string): string {
        // Reject absolute input rather than joining it. Joining would quietly
        // reinterpret "/Personal/x" as "<scope>/Personal/x", which stays
        // confined but answers a question nobody asked; a caller passing an
        // absolute path has misunderstood the API and should be told.
        if (relPath.startsWith("/") || path.isAbsolute(relPath)) {
            throw new PathOutsideScopeError(relPath, this.scope);
        }

        const candidate = path.posix.normalize(path.posix.join(this.scope, relPath));
        if (this.scope === "") {
            if (candidate.startsWith("..")) {
                throw new PathOutsideScopeError(relPath, this.scope);
            }
            return candidate === "." ? "" : candidate;
        }
        // Compare with a trailing separator so "Work2/x" cannot pass for "Work".
        if (candidate !== this.scope && !candidate.startsWith(`${this.scope}/`)) {
            throw new PathOutsideScopeError(relPath, this.scope);
        }
        return candidate;
    }

    /** vault-relative -> scope-relative, for everything handed back. */
    private toScopePath(vaultPath: string): string {
        if (this.scope === "") return vaultPath;
        const prefix = `${this.scope}/`;
        return vaultPath.startsWith(prefix) ? vaultPath.slice(prefix.length) : vaultPath;
    }

    async list(subdir = "", extension: string | null = ".md"): Promise<VaultEntry[]> {
        const entries = await this.inner.list(this.toVaultPath(subdir), extension);
        return entries.map((e) => ({ ...e, path: this.toScopePath(e.path) }));
    }

    /**
     * These are `async` so a rejected path surfaces as a rejected promise
     * rather than a synchronous throw. Mixing the two would force every
     * caller to both try/catch and .catch(), and the one they forgot would be
     * the one that mattered.
     */
    async read(relPath: string): Promise<string | null> {
        return this.inner.read(this.toVaultPath(relPath));
    }

    async write(relPath: string, content: string): Promise<void> {
        return this.inner.write(this.toVaultPath(relPath), content);
    }

    async remove(relPath: string): Promise<boolean> {
        return this.inner.remove(this.toVaultPath(relPath));
    }
}

/** Both failure modes read the same to a caller: an invalid path. */
export function isPathRejection(err: unknown): boolean {
    return err instanceof PathOutsideScopeError || err instanceof PathOutsideVaultError;
}
