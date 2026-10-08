import assert from "node:assert/strict";
import { test } from "node:test";
import { claudeUsage, fetchClaudeUsage } from "../src/usage-bar/claude.ts";
import { describe, health } from "../src/usage-bar/display.ts";
import { validSnapshot } from "../src/usage-bar/quotas.ts";

const now = Date.now();

const modern = {
  limits: [
    { kind: "session", percent: 36, resets_at: "2030-01-01T00:00:00Z" },
    { kind: "weekly_all", percent: 13, resets_at: "2030-01-07T00:00:00Z" },
    {
      kind: "weekly_scoped",
      percent: 41,
      resets_at: "2030-01-07T00:00:00Z",
      scope: { model: { display_name: "Opus 4.8" } },
    },
  ],
};

test("Claude parses the modern limits array into quota windows", () => {
  const snapshot = claudeUsage(modern, now);
  assert.deepEqual(
    snapshot?.limits.map((l) => l.label),
    ["5h", "week", "opus48week"],
  );
  assert.deepEqual(
    snapshot?.limits.map((l) => l.remaining),
    [64, 87, 59],
  );
  assert.equal(snapshot?.limits[0].at, Date.parse("2030-01-01T00:00:00Z"));
  assert.equal(validSnapshot(snapshot), true);
  assert.match(describe("claude", snapshot, now), /Claude: 5h 64% left/);
  assert.equal(health(snapshot, now), "healthy");
});

test("Claude skips malformed entries in the limits array, never fatal", () => {
  const snapshot = claudeUsage(
    {
      limits: [
        { kind: "session", percent: "soon" },
        { kind: "weekly_scoped", percent: 10, scope: {} },
        { kind: "mystery", percent: 5 },
        "not-an-object",
      ],
    },
    now,
  );
  assert.equal(snapshot, undefined);
});

test("Claude falls back to legacy buckets and clamps utilization to 0-100", () => {
  const reset = "2030-01-01T00:00:00Z";
  const snapshot = claudeUsage(
    {
      five_hour: { utilization: 12.5, resets_at: reset },
      seven_day: { utilization: 0, resets_at: reset },
      seven_day_opus: null,
      seven_day_sonnet: { utilization: 1, resets_at: reset },
    },
    now,
  );
  assert.deepEqual(
    snapshot?.limits.map((l) => l.label),
    ["5h", "week", "sonnetweek"],
  );
  assert.equal(snapshot?.limits[0].remaining, 87.5);
  // A legacy bucket beyond 100% is invalid, not clamped.
  assert.equal(
    claudeUsage({ five_hour: { utilization: 101 } }, now),
    undefined,
  );
});

test("Claude surfaces extra-usage spend as a credits fallback", () => {
  const snapshot = claudeUsage(
    {
      ...modern,
      extra_usage: {
        is_enabled: true,
        monthly_limit: 200,
        used_credits: 37.5,
        utilization: 18.75,
      },
    },
    now,
  );
  assert.deepEqual(snapshot?.limits.at(-1), {
    label: "credits",
    unit: "credits",
    remaining: 162.5,
  });
  // Disabled or unlimited extra usage adds nothing.
  assert.equal(
    claudeUsage({ ...modern, extra_usage: { is_enabled: false } }, now)?.limits
      .length,
    3,
  );
});

test("Claude requires all shape fields, never leaks raw payloads", () => {
  assert.equal(claudeUsage({}), undefined);
  assert.equal(claudeUsage({ five_hour: [1] }), undefined);
});

test("fetchClaudeUsage maps auth, beta headers and error states", async () => {
  const seenHeaders: Record<string, string> = {};
  const auth = async () => ({ auth: { apiKey: "test-token" } });
  const ok = await fetchClaudeUsage(
    auth,
    new AbortController().signal,
    async (_url: unknown, options: unknown) => {
      Object.assign(
        seenHeaders,
        (options as { headers: Record<string, string> }).headers,
      );
      return {
        ok: true,
        json: async () => modern,
      } as unknown as Response;
    },
  );
  assert.ok("snapshot" in ok);
  assert.equal(seenHeaders.Authorization, "Bearer test-token");
  assert.equal(seenHeaders["anthropic-beta"], "oauth-2025-04-20");
  assert.match(seenHeaders["user-agent"], /^claude-cli\/\d+\.\d+\.\d+ /);

  for (const [status, expected] of [
    [401, "login required"],
    [429, "rate limited"],
    [500, "HTTP 500"],
  ]) {
    const result = await fetchClaudeUsage(
      auth,
      new AbortController().signal,
      async () => ({ ok: false, status }) as unknown as Response,
    );
    assert.deepEqual(result, { error: expected });
  }

  assert.deepEqual(
    await fetchClaudeUsage(async () => undefined, new AbortController().signal),
    {
      error: "login required",
    },
  );
});
