import type { BackupConfig } from "../config.ts";
import { log, describeError } from "../logger.ts";
import { archiveNdjson, archivePlaintextVault, discardArchive } from "./archive.ts";
import { CouchExporter } from "./couch.ts";
import { S3Uploader } from "./s3.ts";

export type BackupArtifact = {
    kind: "plaintext" | "encrypted";
    key: string;
    bytes: number;
    /** Files for the plaintext artifact, documents for the encrypted one. */
    entries: number;
    /** Files that vanished mid-walk and were left out. */
    skipped: number;
    /** Documents CouchDB claimed to hold, for the encrypted artifact only. */
    expected?: number;
};

export type BackupReport = {
    startedAt: string;
    artifacts: BackupArtifact[];
    /** Set when an artifact failed; the other one is still attempted. */
    failures: { kind: string; error: string }[];
};

/** UTC stamp, so object keys sort chronologically regardless of host timezone. */
function stamp(now: Date): string {
    return now.toISOString().replace(/[:.]/g, "-").replace("Z", "Z");
}

/**
 * Produce both backup artifacts and upload them.
 *
 * The two are independent on purpose: a CouchDB outage must not cost you the
 * plaintext backup, and vice versa. Each failure is reported rather than
 * thrown, so a partial success is visible instead of looking like a clean run.
 */
export async function runBackup(
    vaultDir: string,
    config: BackupConfig,
    now = new Date(),
): Promise<BackupReport> {
    const uploader = new S3Uploader(config);
    const at = stamp(now);
    const report: BackupReport = { startedAt: now.toISOString(), artifacts: [], failures: [] };

    try {
        try {
            const archive = await archivePlaintextVault(vaultDir, `vault-plaintext-${at}`);
            try {
                const key = uploader.objectKey(`plaintext/vault-plaintext-${at}.zip`);
                const up = await uploader.upload(archive.file, key);
                report.artifacts.push({
                    kind: "plaintext",
                    key: up.key,
                    bytes: up.bytes,
                    entries: archive.entries,
                    skipped: archive.skipped,
                });
                log.info("uploaded plaintext backup", {
                    key,
                    bytes: up.bytes,
                    entries: archive.entries,
                    skipped: archive.skipped,
                });
            } finally {
                await discardArchive(archive);
            }
        } catch (err) {
            report.failures.push({ kind: "plaintext", error: describeError(err) });
            log.error("plaintext backup failed", { error: describeError(err) });
        }

        if (config.couch === null) {
            log.info("skipping encrypted backup, CouchDB is not configured");
        } else {
            try {
                const exporter = new CouchExporter(config.couch);
                const expected = await exporter.documentCount();
                const archive = await archiveNdjson(
                    exporter.exportNdjson(),
                    `vault-encrypted-${at}`,
                );
                try {
                    // Refuse to upload an export that is obviously truncated.
                    // Small drift is normal, since documents can change while
                    // the export streams; nothing at all is not.
                    if (expected > 0 && archive.entries === 0) {
                        throw new Error(
                            `CouchDB reports ${expected} documents but the export produced none`,
                        );
                    }
                    if (archive.entries < expected * 0.99) {
                        log.warn("encrypted export is smaller than CouchDB reported", {
                            exported: archive.entries,
                            expected,
                        });
                    }
                    const key = uploader.objectKey(`encrypted/vault-encrypted-${at}.zip`);
                    const up = await uploader.upload(archive.file, key);
                    report.artifacts.push({
                        kind: "encrypted",
                        key: up.key,
                        bytes: up.bytes,
                        entries: archive.entries,
                        skipped: archive.skipped,
                        expected,
                    });
                    log.info("uploaded encrypted backup", {
                        key,
                        bytes: up.bytes,
                        documents: archive.entries,
                        expected,
                    });
                } finally {
                    await discardArchive(archive);
                }
            } catch (err) {
                report.failures.push({ kind: "encrypted", error: describeError(err) });
                log.error("encrypted backup failed", { error: describeError(err) });
            }
        }
    } finally {
        uploader.destroy();
    }

    return report;
}
