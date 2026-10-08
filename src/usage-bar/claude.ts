import { object, type Snapshot } from "./quotas.ts";

// The undocumented endpoint Claude Code's own /usage screen polls.
// Rate limited per access token: keep polling at >=180s intervals (see
// anthropic/claude-code#31637). The UA must impersonate the Claude Code CLI;
// unrecognized clients get aggressively throttled. Keep the version in sync
// with CLAUDE_CODE_VERSION in pi-ant.
const USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const CLAUDE_CODE_VERSION = "2.1.280";

type Auth = {
  auth: { apiKey?: string; headers?: Record<string, string | null> };
};
export type ClaudeResult = { snapshot: Snapshot } | { error: string };

function finite(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function resetsAt(value: unknown): number | undefined {
  const parsed = typeof value === "string" ? Date.parse(value) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : undefined;
}

// Snapshot labels must match /^[a-z0-9]{1,16}$/ (see validSnapshot), so scoped
// model names are squashed: "Opus 4.8" -> "opus48week".
function scopedLabel(name: string): string {
  const slug = name.toLowerCase().replace(/[^a-z0-9]/g, "");
  return `${slug[0] === undefined ? "model" : slug}week`.slice(0, 16);
}

function window(
  used: unknown,
  at: unknown,
  label: string,
): Snapshot["limits"][number] | undefined {
  const percent = finite(used);
  if (percent === undefined || percent < 0 || percent > 100) return undefined;
  const reset = resetsAt(at);
  return {
    label,
    remaining: 100 - percent,
    unit: "%",
    at: reset !== undefined && reset > 0 ? reset : undefined,
    renewal: "reset",
  };
}

export function claudeUsage(
  value: unknown,
  now = Date.now(),
): Snapshot | undefined {
  const body = object(value);
  const limits: Snapshot["limits"] = [];

  // Modern shape: a lenient limits array carrying session/weekly windows,
  // optionally scoped per model. Malformed entries are skipped, never fatal.
  if (Array.isArray(body.limits)) {
    for (const raw of body.limits) {
      const entry = object(raw);
      const kind = typeof entry.kind === "string" ? entry.kind : "";
      if (kind === "session") {
        const limit = window(entry.percent, entry.resets_at, "5h");
        if (limit) limits.push(limit);
      } else if (kind === "weekly_all") {
        const limit = window(entry.percent, entry.resets_at, "week");
        if (limit) limits.push(limit);
      } else if (kind === "weekly_scoped") {
        const name = object(object(entry.scope).model).display_name;
        if (typeof name !== "string" || !name) continue;
        const limit = window(entry.percent, entry.resets_at, scopedLabel(name));
        if (limit) limits.push(limit);
      }
    }
  }

  // Legacy top-level buckets, only when the modern shape covered nothing.
  if (limits.length === 0) {
    const fiveHour = object(body.five_hour);
    const sevenDay = object(body.seven_day);
    const five = window(fiveHour.utilization, fiveHour.resets_at, "5h");
    if (five) limits.push(five);
    const week = window(sevenDay.utilization, sevenDay.resets_at, "week");
    if (week) limits.push(week);
    for (const key of ["seven_day_opus", "seven_day_sonnet"]) {
      const bucket = object(body[key]);
      const label = key === "seven_day_opus" ? "opusweek" : "sonnetweek";
      const limit = window(bucket.utilization, bucket.resets_at, label);
      if (limit) limits.push(limit);
    }
  }

  // Extra-usage spend: paid fallback, not a quota window.
  const extra = object(body.extra_usage);
  const monthly = finite(extra.monthly_limit);
  const used = finite(extra.used_credits);
  if (
    extra.is_enabled === true &&
    monthly !== undefined &&
    monthly > 0 &&
    used !== undefined &&
    used >= 0
  ) {
    limits.push({
      label: "credits",
      remaining: Math.max(0, monthly - used),
      unit: "credits",
    });
  }

  return limits.length ? { updatedAt: now, limits } : undefined;
}

export async function fetchClaudeUsage(
  resolveAuth: () => Promise<Auth | undefined>,
  signal: AbortSignal,
  request: typeof fetch = fetch,
): Promise<ClaudeResult> {
  try {
    const resolved = await resolveAuth();
    signal.throwIfAborted();
    const token = resolved?.auth.apiKey;
    if (!token) return { error: "login required" };
    const response = await request(USAGE_URL, {
      headers: {
        Authorization: `Bearer ${token}`,
        "anthropic-beta": "oauth-2025-04-20",
        "user-agent": `claude-cli/${CLAUDE_CODE_VERSION} (external, cli)`,
        Accept: "application/json",
      },
      redirect: "error",
      signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
    });
    if (!response.ok) {
      return {
        error:
          response.status === 401
            ? "login required"
            : response.status === 429
              ? "rate limited"
              : `HTTP ${response.status}`,
      };
    }
    const snapshot = claudeUsage(await response.json());
    return snapshot ? { snapshot } : { error: "usage unavailable" };
  } catch {
    // Never surface raw exceptions, response bodies, or tokens.
    return { error: signal.aborted ? "cancelled" : "usage check failed" };
  }
}
