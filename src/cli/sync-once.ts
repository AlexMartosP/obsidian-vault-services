import { loadConfig } from "../config.ts";
import { log, describeError } from "../logger.ts";
import { VaultPaths } from "../vault/paths.ts";
import { VaultStore } from "../vault/store.ts";
import { JiraClient } from "../jira/client.ts";
import { JiraSync } from "../jira/sync.ts";

/** One-shot reconcile, for cron-outside-the-container or manual verification. */
const config = loadConfig();
if (config.jira === null) {
    log.error("jira sync is not configured");
    process.exit(2);
}
const store = new VaultStore(new VaultPaths(config.vaultDir));
const sync = new JiraSync(store, new JiraClient(config.jira), config.jira);
try {
    log.info("reconcile result", await sync.reconcile());
} catch (err) {
    log.error("reconcile failed, vault unchanged", { error: describeError(err) });
    process.exit(1);
}
