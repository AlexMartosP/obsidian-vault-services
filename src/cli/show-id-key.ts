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
 * data.json. Note that it is NOT encrypted with the vault passphrase: LiveSync
 * protects sensitive settings with a separate configuration key, chosen by
 * `configPassphraseStore`, and then appends a constant salt:
 *
 *   ""            -> "*"                              (the "Default" option)
 *   LOCALSTORAGE  -> deviceValues["ls-setting-passphrase"]
 *   ASK_AT_LAUNCH -> typed at launch, stored nowhere
 *
 *   key = <that value> + SALT_OF_PASSPHRASE
 *
 * With the default option the key is therefore a constant in the plugin, so
 * this needs no secret from you at all. That also means "Default" obfuscates
 * these settings rather than protecting them: anyone holding the data.json can
 * read the vault passphrase out of it too.
 *
 *   npm run id-key -- ~/vault/.obsidian/plugins/obsidian-livesync/data.json
 */

const dataSchema = z.object({
    idDerivationVersion: z.number().optional(),
    idDerivationKey: z.string().optional(),
    encryptedIdDerivationKey: z.string().optional(),
    configPassphraseStore: z.string().optional(),
});

/** Appended to the configuration passphrase before use, by the plugin. */
const SALT_OF_PASSPHRASE = "rHGMPtr6oWw7VSa3W3wpa8fT8U";
/** What `getPassphrase` resolves to for the "Default" store. */
const DEFAULT_CONFIG_PASSPHRASE = "*";

function fail(message: string): never {
    process.stderr.write(`${message}\n`);
    process.exit(2);
}

/**
 * The configuration passphrase, which is not the vault passphrase.
 *
 * Only the LOCALSTORAGE and ASK_AT_LAUNCH stores involve a real secret, and
 * neither is recorded in data.json, so those are read from stdin or the
 * environment. Never from argv, which `ps` and shell history would expose.
 */
function configPassphrase(store: string): string {
    if (store === "") return DEFAULT_CONFIG_PASSPHRASE;

    const fromEnv = process.env["LIVESYNC_CONFIG_PASSPHRASE"];
    if (fromEnv !== undefined && fromEnv.trim() !== "") return fromEnv;
    let piped = "";
    try {
        piped = fs.readFileSync(0, "utf8").trim();
    } catch {
        piped = "";
    }
    if (piped !== "") return piped;
    fail(
        `configPassphraseStore is ${JSON.stringify(store)}, so this vault uses a custom ` +
            "configuration passphrase. That is the one from the plugin's Configuration " +
            "Encryption settings, not the vault passphrase. Provide it with:\n" +
            "  printf '%s' '<configuration passphrase>' | npm run id-key -- <data.json>\n" +
            "or set LIVESYNC_CONFIG_PASSPHRASE.",
    );
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

const store = data.data.configPassphraseStore ?? "";
const passphrase = configPassphrase(store);
let decrypted: string;
try {
    decrypted = await hkdf.decryptWithEphemeralSalt(encrypted, passphrase + SALT_OF_PASSPHRASE);
} catch {
    fail(
        store === ""
            ? "Could not decrypt the key even though this vault uses the Default " +
                  "configuration store, whose key is a constant. The plugin version may have " +
                  "changed how settings are encrypted."
            : "Could not decrypt the key. The configuration passphrase appears wrong; it is " +
                  "the one from Configuration Encryption in the plugin settings, not the " +
                  "vault passphrase.",
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
