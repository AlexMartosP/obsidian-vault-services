import { loadConfig } from "../config.ts";
import { log } from "../logger.ts";
import { VaultPaths } from "../vault/paths.ts";
import { VaultStore } from "../vault/store.ts";
import { runBackup } from "../backup/run.ts";

/** One-shot backup, useful for verifying credentials and restore drills. */
const config = loadConfig();
if (config.backup === null) {
    log.error("backup is not configured");
    process.exit(2);
}
const store = new VaultStore(new VaultPaths(config.vaultDir));
const report = await runBackup(store.root, config.backup);
log.info("backup report", { ...report });
process.exit(report.failures.length > 0 ? 1 : 0);
