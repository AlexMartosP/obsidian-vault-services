import { describe, expect, it, afterEach, vi } from "vitest";
import { JiraClient, JiraError } from "../src/jira/client.ts";
import type { JiraConfig } from "../src/config.ts";

function config(): JiraConfig {
    return {
        baseUrl: "https://example.atlassian.net",
        email: "me@example.com",
        apiToken: "token",
        jql: "assignee = currentUser()",
        targetSubdir: "Work/Jira",
        taskContext: "Work",
        statusMap: { "In Progress": "in-progress", "In Review": "in-progress" },
        defaultStatus: "in-progress",
        reconcileCron: "*/20 * * * *",
        webhookSecret: null,
        webhookDebounceMs: 2000,
    };
}

type Route = (url: string, init: RequestInit) => Response | Promise<Response>;

function stubFetch(route: Route): void {
    vi.stubGlobal("fetch", (input: string | URL | Request, init?: RequestInit) =>
        Promise.resolve(route(String(input), init ?? {})),
    );
}

function json(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
    });
}

afterEach(() => {
    vi.unstubAllGlobals();
});

describe("credentials are proven before a result is trusted", () => {
    /**
     * The regression that matters. Jira answers the search endpoint with
     * HTTP 200 and an empty issue list when auth is wrong or absent, because
     * currentUser() resolves to nobody. Trusting that would delete every
     * synced note the moment a token expired.
     */
    it("refuses an empty result when /myself is unauthorized", async () => {
        const calls: string[] = [];
        stubFetch((url) => {
            calls.push(url);
            if (url.endsWith("/myself")) return json({ message: "Unauthorized" }, 401);
            return json({ issues: [], isLast: true });
        });

        await expect(new JiraClient(config()).searchActive()).rejects.toThrow(JiraError);
        // The search must not even be attempted once identity fails.
        expect(calls.some((u) => u.includes("/search/jql"))).toBe(false);
    });

    it("refuses when /myself returns 200 but without an account id", async () => {
        stubFetch((url) =>
            url.endsWith("/myself") ? json({}) : json({ issues: [], isLast: true }),
        );
        await expect(new JiraClient(config()).searchActive()).rejects.toThrow(
            /could not confirm the Jira account/,
        );
    });

    it("refuses when the token belongs to a different account", async () => {
        stubFetch((url) =>
            url.endsWith("/myself")
                ? json({ accountId: "abc", emailAddress: "someone.else@example.com" })
                : json({ issues: [], isLast: true }),
        );
        await expect(new JiraClient(config()).searchActive()).rejects.toThrow(
            /belong to someone\.else@example\.com/,
        );
    });

    it("accepts a genuinely empty result once identity is proven", async () => {
        stubFetch((url) =>
            url.endsWith("/myself")
                ? json({ accountId: "abc", emailAddress: "me@example.com" })
                : json({ issues: [], isLast: true }),
        );
        await expect(new JiraClient(config()).searchActive()).resolves.toEqual([]);
    });

    it("tolerates Jira hiding the email address", async () => {
        stubFetch((url) =>
            url.endsWith("/myself")
                ? json({ accountId: "abc" })
                : json({
                      issues: [
                          {
                              key: "TT-1",
                              fields: {
                                  summary: "One",
                                  status: { name: "In Progress" },
                                  issuetype: { name: "Sub-task" },
                              },
                          },
                      ],
                      isLast: true,
                  }),
        );
        await expect(new JiraClient(config()).searchActive()).resolves.toEqual([
            { key: "TT-1", summary: "One", status: "In Progress", issueType: "Sub-task" },
        ]);
    });
});

describe("search behaviour", () => {
    const identity = { accountId: "abc", emailAddress: "me@example.com" };

    it("follows nextPageToken until the last page", async () => {
        let page = 0;
        stubFetch((url, init) => {
            if (url.endsWith("/myself")) return json(identity);
            const body: unknown = JSON.parse(String(init.body ?? "{}"));
            const token =
                typeof body === "object" && body !== null && "nextPageToken" in body
                    ? (body as { nextPageToken?: unknown }).nextPageToken
                    : undefined;
            page++;
            if (token === undefined) {
                return json({
                    issues: [{ key: "TT-1", fields: { summary: "a" } }],
                    nextPageToken: "p2",
                });
            }
            return json({ issues: [{ key: "TT-2", fields: { summary: "b" } }], isLast: true });
        });

        const issues = await new JiraClient(config()).searchActive();
        expect(issues.map((i) => i.key)).toEqual(["TT-1", "TT-2"]);
        expect(page).toBe(2);
    });

    it("throws on a non-2xx search rather than reporting nothing active", async () => {
        stubFetch((url) =>
            url.endsWith("/myself") ? json(identity) : json({ errorMessages: ["bad jql"] }, 400),
        );
        await expect(new JiraClient(config()).searchActive()).rejects.toThrow(/HTTP 400/);
    });

    it("throws when the search body is not the expected shape", async () => {
        stubFetch((url) => (url.endsWith("/myself") ? json(identity) : json({ issues: "nope" })));
        await expect(new JiraClient(config()).searchActive()).rejects.toThrow(
            /unexpected Jira search response/,
        );
    });

    it("throws when Jira is unreachable", async () => {
        vi.stubGlobal("fetch", () => Promise.reject(new Error("ECONNREFUSED")));
        await expect(new JiraClient(config()).searchActive()).rejects.toThrow(/could not reach Jira/);
    });
});
