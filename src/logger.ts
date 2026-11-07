type Level = "debug" | "info" | "warn" | "error";

const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

const threshold = ORDER[(process.env.LOG_LEVEL as Level | undefined) ?? "info"] ?? ORDER.info;

function emit(level: Level, msg: string, fields?: Record<string, unknown>): void {
    if (ORDER[level] < threshold) return;
    const line = JSON.stringify({ ts: new Date().toISOString(), level, msg, ...fields });
    if (level === "error" || level === "warn") process.stderr.write(line + "\n");
    else process.stdout.write(line + "\n");
}

export const log = {
    debug: (msg: string, fields?: Record<string, unknown>) => emit("debug", msg, fields),
    info: (msg: string, fields?: Record<string, unknown>) => emit("info", msg, fields),
    warn: (msg: string, fields?: Record<string, unknown>) => emit("warn", msg, fields),
    error: (msg: string, fields?: Record<string, unknown>) => emit("error", msg, fields),
};

/** Errors arrive as `unknown`; render one without assuming it is an Error. */
export function describeError(err: unknown): string {
    if (err instanceof Error) return err.message;
    if (typeof err === "string") return err;
    return JSON.stringify(err);
}
