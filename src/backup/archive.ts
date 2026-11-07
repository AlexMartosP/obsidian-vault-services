import { ZipArchive, type Archiver } from "archiver";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";

export type ArchiveResult = {
    /** Absolute path to the finished zip on local disk. */
    file: string;
    bytes: number;
    entries: number;
};

/** Names never worth backing up, including our own atomic-write temp files. */
const EXCLUDE_DIRS = new Set([".git", "node_modules", ".trash"]);

async function withZip(
    label: string,
    fill: (zip: Archiver) => void | Promise<void>,
): Promise<ArchiveResult> {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "vault-backup-"));
    const file = path.join(dir, `${label}.zip`);
    const out = fs.createWriteStream(file);
    const zip = new ZipArchive({ zlib: { level: 9 } });

    let entries = 0;
    zip.on("entry", () => {
        entries++;
    });

    const finished = new Promise<void>((resolve, reject) => {
        out.on("close", () => resolve());
        out.on("error", reject);
        zip.on("error", reject);
        // A warning such as a vanished file would otherwise be swallowed.
        zip.on("warning", reject);
    });

    zip.pipe(out);
    await fill(zip);
    await zip.finalize();
    await finished;

    const st = await fsp.stat(file);
    return { file, bytes: st.size, entries };
}

/**
 * Zip the vault as readable files. This artifact is plaintext: it is
 * restorable into any tool and greppable, and it must be treated as sensitive
 * wherever it lands.
 */
export function archivePlaintextVault(vaultDir: string, label: string): Promise<ArchiveResult> {
    return withZip(label, (zip) => {
        zip.glob("**/*", {
            cwd: vaultDir,
            dot: true,
            nodir: true,
            ignore: [
                ...[...EXCLUDE_DIRS].map((d) => `${d}/**`),
                ".*.tmp-*",
                "**/.*.tmp-*",
            ],
        });
    });
}

/** Zip a stream of NDJSON lines as a single entry, for the raw CouchDB export. */
export function archiveNdjson(
    lines: AsyncIterable<string>,
    label: string,
    entryName = "documents.ndjson",
): Promise<ArchiveResult> {
    return withZip(label, (zip) => {
        zip.append(Readable.from(lines), { name: entryName });
    });
}

export async function discardArchive(result: ArchiveResult): Promise<void> {
    await fsp.rm(path.dirname(result.file), { recursive: true, force: true });
}
