import { z } from "zod";
import type { JiraConfig } from "../config.ts";
import { log } from "../logger.ts";

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

/** Carries the status so callers can tell "not authenticated" from "forbidden". */
export class JiraHttpError extends JiraError {
    constructor(
        readonly status: number,
        message: string,
    ) {
        super(message);
    }
}

/**
 * Identity check, and it is load bearing rather than cosmetic.
 *
 * `POST /rest/api/3/search/jql` answers HTTP 200 with `{"issues":[]}` when the
 * credentials are wrong, and even when there are no credentials at all:
 * `assignee = currentUser()` resolves to nobody, and zero matches is a valid
 * answer to a valid query. Verified against Jira Cloud.
 *
 * Taken at face value that empty list means "nothing is active any more",
 * which would delete every synced note the moment an API token expired. So
 * before trusting any result we confirm the request is actually authenticated
 * as the configured account, and treat failure as "state unknown".
 */
const myselfSchema = z.object({
    accountId: z.string().min(1),
    emailAddress: z.string().nullish(),
});

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
     * Confirm we are authenticated as the configured account.
     *
     * Throws if the request is anonymous, the token is rejected, or the token
     * belongs to somebody else. See the note on `myselfSchema` for why an
     * empty search result cannot be trusted without this.
     */
    async verifyIdentity(signal?: AbortSignal): Promise<{ accountId: string | null }> {
        const url = `${this.config.baseUrl.replace(/\/+$/, "")}/rest/api/3/myself`;

        let body: unknown;
        try {
            body = await this.request("GET", url, undefined, signal);
        } catch (err) {
            /**
             * 403 means the credentials were accepted and then refused for
             * this endpoint, which is what a scoped API token without a
             * user-read scope does. That still answers the only question that
             * matters here: the request is not anonymous, so an empty search
             * result is a real empty result rather than a silent auth failure.
             *
             * 401 is the dangerous one and stays fatal.
             */
            if (err instanceof JiraHttpError && err.status === 403) {
                log.warn(
                    "cannot read the Jira account for these credentials, continuing: " +
                        "authentication succeeded, so an empty result is trustworthy, " +
                        "but the account could not be confirmed. Add a user-read scope " +
                        "to the token to restore the check.",
                    { status: err.status },
                );
                return { accountId: null };
            }
            throw err;
        }

        const parsed = myselfSchema.safeParse(body);
        if (!parsed.success) {
            throw new JiraError(
                "could not confirm the Jira account for these credentials, " +
                    "refusing to act on the result",
            );
        }

        const actual = parsed.data.emailAddress;
        // Jira hides the address under some privacy settings, so only compare
        // when it is actually returned.
        if (
            typeof actual === "string" &&
            actual.toLowerCase() !== this.config.email.toLowerCase()
        ) {
            throw new JiraError(
                `credentials belong to ${actual}, not ${this.config.email}, refusing to sync`,
            );
        }
        return { accountId: parsed.data.accountId };
    }

    /**
     * Every issue matching the configured JQL. Throws on any transport or
     * protocol failure; callers must treat a throw as "state unknown" and
     * leave the vault untouched.
     */
    async searchActive(signal?: AbortSignal): Promise<JiraIssue[]> {
        // Must happen before the search, so an auth failure can never be
        // mistaken for an empty result set.
        await this.verifyIdentity(signal);

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

            const response = await this.request("POST", url, body, signal);
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

    private async request(
        method: "GET" | "POST",
        url: string,
        body: Record<string, unknown> | undefined,
        signal?: AbortSignal,
    ): Promise<unknown> {
        let response: Response;
        try {
            response = await fetch(url, {
                method,
                headers: {
                    Authorization: this.authHeader,
                    "Content-Type": "application/json",
                    Accept: "application/json",
                },
                ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
                ...(signal ? { signal } : {}),
            });
        } catch (err) {
            throw new JiraError(
                `could not reach Jira: ${err instanceof Error ? err.message : String(err)}`,
            );
        }

        if (!response.ok) {
            const detail = (await response.text().catch(() => "")).slice(0, 400);
            throw new JiraHttpError(
                response.status,
                `Jira returned HTTP ${response.status}: ${detail}`,
            );
        }

        try {
            return await response.json();
        } catch {
            throw new JiraError("Jira returned a body that is not JSON");
        }
    }
}
