import { ZipArchive, type Archiver } from "archiver";
import { log, describeError } from "../logger.ts";
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
    /** Files that vanished mid-walk and were left out. */
    skipped: number;
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
    let skipped = 0;
    zip.on("entry", () => {
        entries++;
    });

    const finished = new Promise<void>((resolve, reject) => {
        out.on("close", () => resolve());
        out.on("error", reject);
        zip.on("error", reject);
        /**
         * archiver emits `warning` (not `error`) when lstat fails on a file the
         * glob already matched, which is exactly the ENOENT race this service
         * lives with: livesync-bridge, or its own atomic rename during a
         * concurrent reconcile, can remove a file between match and stat.
         * Rejecting here would abort the whole backup over one vanished note,
         * so the file is skipped and counted instead.
         */
        zip.on("warning", (err: unknown) => {
            skipped++;
            log.warn("skipped a file while archiving", { error: describeError(err) });
        });
    });

    zip.pipe(out);
    await fill(zip);
    await zip.finalize();
    await finished;

    const st = await fsp.stat(file);
    return { file, bytes: st.size, entries, skipped };
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
export async function archiveNdjson(
    lines: AsyncIterable<string>,
    label: string,
    entryName = "documents.ndjson",
): Promise<ArchiveResult> {
    // The whole export is one zip entry, so the entry counter would always say
    // 1. Count the lines as they stream instead, so `entries` is the document
    // count and a truncated export is detectable.
    let documents = 0;
    async function* counted(): AsyncGenerator<string> {
        for await (const line of lines) {
            documents++;
            yield line;
        }
    }
    const result = await withZip(label, (zip) => {
        zip.append(Readable.from(counted()), { name: entryName });
    });
    return { ...result, entries: documents };
}

export async function discardArchive(result: ArchiveResult): Promise<void> {
    await fsp.rm(path.dirname(result.file), { recursive: true, force: true });
}
