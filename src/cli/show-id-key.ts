import fs from "node:fs";
import { hkdf } from "octagonal-wheels/encryption";
import { z } from "zod";

/**
 * Recover the document ID derivation key from an Obsidian LiveSync vault.
 *
 * livesync-bridge needs this key, and gives the same error whether it is
 * missing or wrong:
 *
 *   Direct database document IDs do not match the configured ID key.
 *
 * Obsidian stores the key only as `encryptedIdDerivationKey` in the plugin's
 * data.json, encrypted with the vault passphrase, so the recovery code shown
 * in settings is normally the only way to read it. This decrypts it directly,
 * which settles whether a recovery code you have is actually this vault's key
 * rather than one from an older or different vault.
 *
 * Runs locally and talks to nothing. The passphrase is read from stdin or the
 * environment rather than argv, so it does not land in shell history or `ps`.
 *
 *   npm run id-key -- ~/vault/.obsidian/plugins/obsidian-livesync/data.json
 */

const dataSchema = z.object({
    idDerivationVersion: z.number().optional(),
    idDerivationKey: z.string().optional(),
    encryptedIdDerivationKey: z.string().optional(),
});

function fail(message: string): never {
    process.stderr.write(`${message}\n`);
    process.exit(2);
}

function readPassphrase(): string {
    const fromEnv = process.env["VAULT_E2EE_PASSPHRASE"];
    if (fromEnv !== undefined && fromEnv.trim() !== "") return fromEnv;
    try {
        // Deliberately not argv: that would be visible in `ps` and history.
        return fs.readFileSync(0, "utf8").trim();
    } catch {
        fail(
            "No passphrase. Pipe it in, or set VAULT_E2EE_PASSPHRASE:\n" +
                "  printf '%s' 'your-passphrase' | npm run id-key -- <data.json>",
        );
    }
}

const path = process.argv[2];
if (path === undefined) {
    fail("usage: npm run id-key -- <path to obsidian-livesync/data.json>");
}

let parsedFile: unknown;
try {
    parsedFile = JSON.parse(fs.readFileSync(path, "utf8"));
} catch (err) {
    fail(`could not read ${path}: ${err instanceof Error ? err.message : String(err)}`);
}

const data = dataSchema.safeParse(parsedFile);
if (!data.success) fail(`${path} is not a LiveSync data.json: ${data.error.message}`);

const plain = data.data.idDerivationKey;
if (plain !== undefined && plain.trim() !== "") {
    // Some vaults keep it unencrypted; no passphrase needed then.
    report(plain.trim(), data.data.idDerivationVersion);
}

const encrypted = data.data.encryptedIdDerivationKey;
if (encrypted === undefined || encrypted.trim() === "") {
    fail(
        "This vault has no idDerivationKey or encryptedIdDerivationKey, so it does not " +
            "use ID derivation. Leave VAULT_ID_DERIVATION_KEY unset.",
    );
}
if (!encrypted.startsWith(hkdf.HKDF_SALTED_ENCRYPTED_PREFIX)) {
    fail(
        `encryptedIdDerivationKey has an unexpected prefix ${JSON.stringify(encrypted.slice(0, 2))}; ` +
            `expected ${JSON.stringify(hkdf.HKDF_SALTED_ENCRYPTED_PREFIX)}. This tool may be out of date ` +
            "with your plugin version.",
    );
}

const passphrase = readPassphrase();
let decrypted: string;
try {
    decrypted = await hkdf.decryptWithEphemeralSalt(encrypted, passphrase);
} catch {
    fail(
        "Could not decrypt the key. The passphrase is almost certainly wrong: it must be " +
            "exactly the one in the LiveSync plugin's settings for this vault.",
    );
}

report(decrypted.trim(), data.data.idDerivationVersion);

function report(key: string, version: number | undefined): never {
    if (!/^[0-9a-f]{64}$/i.test(key)) {
        fail(`recovered a value that is not a 64 character hex key (length ${key.length})`);
    }
    const normalised = key.toLowerCase();
    process.stdout.write(
        [
            "",
            `idDerivationVersion: ${version ?? "(unset)"}`,
            "",
            "Set this in your environment:",
            "",
            `  VAULT_ID_DERIVATION_KEY=${normalised}`,
            "",
            `Equivalent recovery code form: sls-id-v1:${normalised}`,
            "",
            "This is a secret. It derives your document IDs, so treat it like the passphrase.",
            "",
        ].join("\n"),
    );
    process.exit(0);
}
