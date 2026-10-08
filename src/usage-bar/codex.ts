import { object, type Snapshot } from "./quotas.ts";

const USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
type Auth = {
  auth: { apiKey?: string; headers?: Record<string, string | null> };
};
export type CodexResult = { snapshot: Snapshot } | { error: string };

function finite(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

export function codexUsage(
  value: unknown,
  now = Date.now(),
): Snapshot | undefined {
  const body = object(value);
  const rate = object(body.rate_limit);
  const limits: Snapshot["limits"] = [];
  for (const name of ["primary", "secondary"]) {
    const window = object(rate[`${name}_window`]);
    const used = finite(window.used_percent);
    if (used === undefined || used < 0 || used > 100) continue;
    const seconds = finite(window.limit_window_seconds);
    if (seconds === undefined || seconds <= 0) continue;
    const reset = finite(window.reset_at);
    const after = finite(window.reset_after_seconds);
    limits.push({
      label: seconds === 18000 ? "5h" : seconds === 604800 ? "week" : name,
      remaining: 100 - used,
      unit: "%",
      at:
        reset !== undefined && reset > 0
          ? reset * 1000
          : after !== undefined && after >= 0
            ? now + after * 1000
            : undefined,
      renewal: "reset",
    });
  }
  const credits = object(body.credits);
  const raw = credits.balance;
  const balance = finite(
    typeof raw === "string" && raw.trim() ? Number(raw) : raw,
  );
  if (credits.unlimited !== true && balance !== undefined && balance >= 0) {
    limits.push({ label: "credits", remaining: balance, unit: "credits" });
  }
  return limits.length ? { updatedAt: now, limits } : undefined;
}

export async function fetchCodexUsage(
  resolveAuth: () => Promise<Auth | undefined>,
  signal: AbortSignal,
  request: typeof fetch = fetch,
): Promise<CodexResult> {
  try {
    const resolved = await resolveAuth();
    signal.throwIfAborted();
    const token = resolved?.auth.apiKey;
    if (!token) return { error: "login required" };
    const headers = new Headers({
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
    });
    // Use only the account selector, never arbitrary configured headers or URLs.
    const configured = Object.entries(resolved.auth.headers ?? {}).find(
      ([key]) => key.toLowerCase() === "chatgpt-account-id",
    )?.[1];
    let accountId = configured;
    if (!accountId) {
      try {
        const claims = object(
          JSON.parse(
            Buffer.from(token.split(".")[1] ?? "", "base64url").toString(
              "utf8",
            ),
          ),
        );
        const account = object(
          claims["https://api.openai.com/auth"],
        ).chatgpt_account_id;
        if (typeof account === "string") accountId = account;
      } catch {
        /* Some credentials have an explicit account header instead. */
      }
    }
    if (accountId) headers.set("chatgpt-account-id", accountId);
    const response = await request(USAGE_URL, {
      headers,
      redirect: "error",
      signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
    });
    if (!response.ok) {
      return {
        error:
          response.status === 401
            ? "login required"
            : `HTTP ${response.status}`,
      };
    }
    const snapshot = codexUsage(await response.json());
    return snapshot ? { snapshot } : { error: "usage unavailable" };
  } catch {
    // Never surface raw exceptions, response bodies, tokens, or account metadata.
    return { error: signal.aborted ? "cancelled" : "usage check failed" };
  }
}
