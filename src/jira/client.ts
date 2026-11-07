import { z } from "zod";
import type { JiraConfig } from "../config.ts";

export type JiraIssue = {
    key: string;
    summary: string;
    status: string;
    issueType: string;
};

/**
 * Responses are validated rather than cast, so a change in Jira's payload
 * surfaces as a clear parse error instead of undefined fields reaching the
 * vault. Nested objects are nullish because Jira omits fields the account
 * cannot see.
 */
const issueSchema = z.object({
    key: z.string().min(1),
    fields: z
        .object({
            summary: z.string().nullish(),
            status: z.object({ name: z.string() }).nullish(),
            issuetype: z.object({ name: z.string() }).nullish(),
        })
        .default({}),
});

const searchResponseSchema = z.object({
    issues: z.array(issueSchema).default([]),
    nextPageToken: z.string().nullish(),
    isLast: z.boolean().nullish(),
});

export class JiraError extends Error {}

/** Guard against an unbounded loop if Jira keeps handing back page tokens. */
const MAX_PAGES = 50;
const PAGE_SIZE = 100;

export class JiraClient {
    private readonly authHeader: string;

    constructor(private readonly config: JiraConfig) {
        const cred = Buffer.from(`${config.email}:${config.apiToken}`).toString("base64");
        this.authHeader = `Basic ${cred}`;
    }

    /**
     * Every issue matching the configured JQL. Throws on any transport or
     * protocol failure; callers must treat a throw as "state unknown" and
     * leave the vault untouched.
     */
    async searchActive(signal?: AbortSignal): Promise<JiraIssue[]> {
        const url = `${this.config.baseUrl.replace(/\/+$/, "")}/rest/api/3/search/jql`;
        const collected: JiraIssue[] = [];
        let pageToken: string | null = null;

        for (let page = 0; page < MAX_PAGES; page++) {
            const body: Record<string, unknown> = {
                jql: this.config.jql,
                maxResults: PAGE_SIZE,
                fields: ["summary", "status", "issuetype"],
            };
            if (pageToken !== null) body["nextPageToken"] = pageToken;

            const response = await this.post(url, body, signal);
            const parsed = searchResponseSchema.safeParse(response);
            if (!parsed.success) {
                throw new JiraError(
                    `unexpected Jira search response: ${parsed.error.message}`,
                );
            }

            for (const issue of parsed.data.issues) {
                collected.push({
                    key: issue.key,
                    summary: (issue.fields.summary ?? "").trim(),
                    status: issue.fields.status?.name.trim() ?? "",
                    issueType: issue.fields.issuetype?.name.trim() ?? "",
                });
            }

            const next = parsed.data.nextPageToken;
            if (parsed.data.isLast === true || next === null || next === undefined) break;
            pageToken = next;
        }

        return collected;
    }

    private async post(
        url: string,
        body: Record<string, unknown>,
        signal?: AbortSignal,
    ): Promise<unknown> {
        let response: Response;
        try {
            response = await fetch(url, {
                method: "POST",
                headers: {
                    Authorization: this.authHeader,
                    "Content-Type": "application/json",
                    Accept: "application/json",
                },
                body: JSON.stringify(body),
                ...(signal ? { signal } : {}),
            });
        } catch (err) {
            throw new JiraError(
                `could not reach Jira: ${err instanceof Error ? err.message : String(err)}`,
            );
        }

        if (!response.ok) {
            const detail = (await response.text().catch(() => "")).slice(0, 400);
            throw new JiraError(`Jira returned HTTP ${response.status}: ${detail}`);
        }

        try {
            return await response.json();
        } catch {
            throw new JiraError("Jira returned a body that is not JSON");
        }
    }
}
