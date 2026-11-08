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
    /**
     * Written to a temp file then renamed, so the bridge never reads a
     * half-written config.
     *
     * Mode 644 rather than 600 on purpose: this container and the bridge are
     * different images and need not share a uid, and a 600 file written by
     * one uid is simply unreadable by the other, which fails at startup with
     * EACCES. The protection here comes from where the file lives, a Docker
     * volume that is root-only on the host, not from the mode inside a
     * container whose only process is the bridge itself.
     */
    const tmp = `${target}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(config, null, 2) + "\n", { mode: 0o644 });
    fs.renameSync(tmp, target);

    // Read back before claiming success. The bridge gates on this file
    // existing and being non-empty, so an init step that exits 0 without
    // having written it is the worst outcome: the bridge then starts and
    // silently syncs nothing.
    const written = fs.statSync(target);
    if (!written.isFile() || written.size === 0) {
        throw new BridgeConfigError(`wrote ${target} but it is empty`);
    }

    log.info("rendered livesync-bridge config", {
        target,
        bytes: written.size,
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
