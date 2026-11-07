import { z } from "zod";
import type { CouchConfig } from "../config.ts";

/**
 * Raw export straight from CouchDB.
 *
 * Documents are written out exactly as stored, which means still encrypted and
 * with obfuscated paths. That is the point: this artifact preserves end to end
 * encryption all the way into the bucket. It is only restorable with the vault
 * passphrase.
 */

const rowSchema = z.object({
    id: z.string(),
    doc: z.unknown().nullish(),
});

const allDocsSchema = z.object({
    total_rows: z.number().nullish(),
    rows: z.array(rowSchema).default([]),
});

export class CouchError extends Error {}

const PAGE_SIZE = 500;

export class CouchExporter {
    private readonly authHeader: string;
    private readonly dbUrl: string;

    constructor(config: CouchConfig) {
        const cred = Buffer.from(`${config.user}:${config.password}`).toString("base64");
        this.authHeader = `Basic ${cred}`;
        this.dbUrl = `${config.url.replace(/\/+$/, "")}/${encodeURIComponent(config.database)}`;
    }

    /** Document count, used to sanity check an export before it replaces a good one. */
    async documentCount(): Promise<number> {
        const body = await this.get(`${this.dbUrl}`);
        const parsed = z.object({ doc_count: z.number() }).safeParse(body);
        if (!parsed.success) throw new CouchError("could not read doc_count from CouchDB");
        return parsed.data.doc_count;
    }

    /**
     * Yield every document as a JSON line. Paged by document id rather than
     * `skip`, so a concurrent write cannot make the export silently skip rows.
     */
    async *exportNdjson(): AsyncGenerator<string> {
        let startkey: string | null = null;
        let guard = 0;

        for (;;) {
            if (guard++ > 100_000) throw new CouchError("export exceeded page guard");

            const url = new URL(`${this.dbUrl}/_all_docs`);
            url.searchParams.set("include_docs", "true");
            url.searchParams.set("limit", String(PAGE_SIZE + 1));
            if (startkey !== null) url.searchParams.set("startkey", JSON.stringify(startkey));

            const parsed = allDocsSchema.safeParse(await this.get(url.toString()));
            if (!parsed.success) {
                throw new CouchError(`unexpected _all_docs response: ${parsed.error.message}`);
            }

            const rows = parsed.data.rows;
            if (rows.length === 0) return;

            // The extra row is the cursor for the next page, not output yet.
            const page = rows.slice(0, PAGE_SIZE);
            const overflow = rows[PAGE_SIZE];

            for (const row of page) {
                if (row.doc === null || row.doc === undefined) continue;
                yield JSON.stringify(row.doc) + "\n";
            }

            if (overflow === undefined) return;
            startkey = overflow.id;
        }
    }

    private async get(url: string): Promise<unknown> {
        let response: Response;
        try {
            response = await fetch(url, {
                headers: { Authorization: this.authHeader, Accept: "application/json" },
            });
        } catch (err) {
            throw new CouchError(
                `could not reach CouchDB: ${err instanceof Error ? err.message : String(err)}`,
            );
        }
        if (!response.ok) {
            const detail = (await response.text().catch(() => "")).slice(0, 300);
            throw new CouchError(`CouchDB returned HTTP ${response.status}: ${detail}`);
        }
        try {
            return await response.json();
        } catch {
            throw new CouchError("CouchDB returned a body that is not JSON");
        }
    }
}
