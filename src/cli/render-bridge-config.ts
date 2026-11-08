import fs from "node:fs";
import path from "node:path";
import { buildBridgeConfig, redactBridgeConfig, BridgeConfigError } from "../bridge-config.ts";
import { log, describeError } from "../logger.ts";

/**
 * Init step: render livesync-bridge's config.json from the environment.
 *
 * Runs to completion before the bridge starts, writing into a tmpfs-backed
 * volume the two containers share. Keeps the CouchDB password and the vault
 * passphrase out of any file on the host.
 */
const target = process.argv[2] ?? "/render/config.json";

try {
    const config = buildBridgeConfig(process.env);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    // Written restrictively, then renamed, so the bridge never reads a
    // half-written file and nothing else on the box can read it.
    const tmp = `${target}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(config, null, 2) + "\n", { mode: 0o600 });
    fs.renameSync(tmp, target);
    log.info("rendered livesync-bridge config", {
        target,
        config: redactBridgeConfig(config),
    });
} catch (err) {
    if (err instanceof BridgeConfigError) {
        log.error("bridge config not rendered", { error: err.message });
        process.exit(2);
    }
    log.error("bridge config not rendered", { error: describeError(err) });
    process.exit(1);
}
