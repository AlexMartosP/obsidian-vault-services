/**
 * Rendering and recognition of the TaskNotes notes this service owns.
 *
 * The frontmatter shape matches the vault's TaskNotes config: `tags: [task]`
 * plus `contexts: [<context>]` is what the "Work tasks" base filters on, and
 * `status` must be one of the values defined in TaskNotes settings.
 *
 * `source: jira` is the ownership marker. Only notes carrying it are ever
 * rewritten or deleted, so hand written notes in the vault are never at risk.
 */

export const SOURCE_MARKER = "jira";
const TASK_TAG = "task";

export type JiraNoteInput = {
    key: string;
    summary: string;
    /** Jira's own status name, kept for visibility in the note. */
    jiraStatus: string;
    issueType: string;
    browseUrl: string;
    /** TaskNotes status value, e.g. "in-progress". */
    taskStatus: string;
    context: string;
    /** Preserved across rewrites so the note keeps its original creation time. */
    dateCreated: string | null;
    now: Date;
};

/** A double quoted YAML scalar. JSON string syntax is a valid subset. */
function yamlString(value: string): string {
    return JSON.stringify(value);
}

function isoWithOffset(d: Date): string {
    const pad = (n: number, w = 2) => String(Math.abs(n)).padStart(w, "0");
    const offsetMin = -d.getTimezoneOffset();
    const sign = offsetMin >= 0 ? "+" : "-";
    const offset = `${sign}${pad(Math.floor(Math.abs(offsetMin) / 60))}:${pad(Math.abs(offsetMin) % 60)}`;
    return (
        `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
        `T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}` +
        `.${pad(d.getMilliseconds(), 3)}${offset}`
    );
}

export function renderJiraNote(input: JiraNoteInput): string {
    const now = isoWithOffset(input.now);
    const label = input.summary === "" ? input.key : `${input.key}: ${input.summary}`;
    return [
        "---",
        `status: ${input.taskStatus}`,
        "priority: normal",
        `dateCreated: ${input.dateCreated ?? now}`,
        `dateModified: ${now}`,
        "contexts:",
        `  - ${input.context}`,
        "tags:",
        `  - ${TASK_TAG}`,
        `jiraKey: ${input.key}`,
        `jiraStatus: ${yamlString(input.jiraStatus)}`,
        `jiraType: ${yamlString(input.issueType)}`,
        `source: ${SOURCE_MARKER}`,
        "---",
        "",
        `[${label}](${input.browseUrl})`,
        "",
    ].join("\n");
}

export type SyncOwnedNote = {
    jiraKey: string;
    dateCreated: string | null;
};

/**
 * Recognise a note this service owns. Returns null for anything else,
 * including notes that merely mention Jira in their body: the marker and the
 * key must both appear inside the leading frontmatter block.
 */
export function parseSyncOwnedNote(content: string): SyncOwnedNote | null {
    const frontmatter = extractFrontmatter(content);
    if (frontmatter === null) return null;

    const source = matchField(frontmatter, "source");
    if (source !== SOURCE_MARKER) return null;

    const jiraKey = matchField(frontmatter, "jiraKey");
    if (jiraKey === null || jiraKey === "") return null;

    return { jiraKey, dateCreated: matchField(frontmatter, "dateCreated") };
}

function extractFrontmatter(content: string): string | null {
    if (!content.startsWith("---")) return null;
    const afterOpen = content.indexOf("\n");
    if (afterOpen === -1) return null;
    const close = content.indexOf("\n---", afterOpen);
    if (close === -1) return null;
    return content.slice(afterOpen + 1, close);
}

function matchField(frontmatter: string, field: string): string | null {
    const re = new RegExp(`^${field}:[ \\t]*(.*)$`, "m");
    const m = re.exec(frontmatter);
    if (m === null) return null;
    const raw = m[1];
    if (raw === undefined) return null;
    const trimmed = raw.trim();
    if (trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length >= 2) {
        try {
            const parsed: unknown = JSON.parse(trimmed);
            return typeof parsed === "string" ? parsed : trimmed;
        } catch {
            return trimmed;
        }
    }
    return trimmed;
}

/**
 * Compare two renderings ignoring `dateModified`, so a reconcile that found
 * nothing new does not rewrite every note and wake the sync watcher.
 */
export function sameIgnoringModified(a: string, b: string): boolean {
    const strip = (s: string) => s.replace(/^dateModified:.*$/m, "");
    return strip(a) === strip(b);
}
