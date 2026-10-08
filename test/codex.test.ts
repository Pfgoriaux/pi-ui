import assert from "node:assert/strict";
import { test } from "node:test";
import { codexUsage, fetchCodexUsage } from "../src/usage-bar/codex.ts";
import { colorize, describe, health } from "../src/usage-bar/display.ts";
import { validSnapshot } from "../src/usage-bar/quotas.ts";

const now = Date.now();
const usage = {
  rate_limit: {
    primary_window: {
      used_percent: 18,
      limit_window_seconds: 18000,
      reset_at: (now + 3600000) / 1000,
    },
    secondary_window: {
      used_percent: 60,
      limit_window_seconds: 604800,
      reset_after_seconds: 7200,
    },
  },
  credits: { balance: "4.25", unlimited: false },
};
test("Codex parses windows, epoch/relative resets and paid credit units", () => {
  const snapshot = codexUsage(usage, now);
  assert.equal(snapshot?.limits[0].remaining, 82);
  assert.equal(snapshot?.limits[0].at, now + 3600000);
  assert.equal(snapshot?.limits[1].remaining, 40);
  assert.equal(snapshot?.limits[1].at, now + 7200000);
  assert.deepEqual(snapshot?.limits[2], {
    label: "credits",
    unit: "credits",
    remaining: 4.25,
  });
  assert.equal(validSnapshot(snapshot), true);
  // credits are filtered out of display
  assert.match(describe("codex", snapshot, now), /week 40% left/);
  assert.equal(health(snapshot, now), "warning");
  assert.equal(codexUsage({}), undefined);
  assert.equal(
    codexUsage({ rate_limit: { primary_window: { used_percent: "5" } } }),
    undefined,
  );
  assert.equal(
    codexUsage({ credits: { unlimited: true, balance: "0" } }),
    undefined,
  );
});

test("absent or disabled secondary windows do not make Codex stale", () => {
  for (const secondary_window of [
    null,
    { used_percent: 0, limit_window_seconds: 0, reset_after_seconds: 0 },
  ]) {
    const snapshot = codexUsage(
      {
        rate_limit: {
          primary_window: {
            used_percent: 41,
            limit_window_seconds: 604800,
            reset_at: (now + 3600000) / 1000,
          },
          secondary_window,
        },
      },
      now,
    );
    assert.equal(snapshot?.limits.length, 1);
    assert.equal(health(snapshot, now), "healthy");
    assert.doesNotMatch(
      describe("codex", snapshot, now),
      /secondary|refresh due/,
    );
  }
});

test("request uses existing auth and fixed ChatGPT endpoint, without redirects", async () => {
  const token = `test.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "test-account" } })).toString("base64url")}.test`;
  let calls = 0;
  const result = await fetchCodexUsage(
    async () => ({ auth: { apiKey: token } }),
    new AbortController().signal,
    (async (url, options) => {
      calls++;
      assert.equal(url, "https://chatgpt.com/backend-api/wham/usage");
      assert.equal(options?.redirect, "error");
      const headers = new Headers(options?.headers);
      assert.equal(headers.get("Authorization"), `Bearer ${token}`);
      assert.equal(headers.get("chatgpt-account-id"), "test-account");
      assert.ok(options?.signal);
      return Response.json(usage);
    }) as typeof fetch,
  );
  assert.equal(calls, 1);
  assert.ok("snapshot" in result);
});
test("missing auth and shutdown abort do not contact network", async () => {
  const request = (async () => {
    throw new Error("must not fetch");
  }) as typeof fetch;
  assert.deepEqual(
    await fetchCodexUsage(
      async () => undefined,
      new AbortController().signal,
      request,
    ),
    { error: "login required" },
  );
  const abort = new AbortController();
  abort.abort();
  assert.deepEqual(
    await fetchCodexUsage(
      async () => ({ auth: { apiKey: "test" } }),
      abort.signal,
      request,
    ),
    { error: "cancelled" },
  );
});
test("errors never expose raw response or credential text", async () => {
  const auth = async () => ({ auth: { apiKey: "test" } });
  const signal = new AbortController().signal;
  const denied = await fetchCodexUsage(
    auth,
    signal,
    (async () =>
      new Response("sensitive body", { status: 401 })) as typeof fetch,
  );
  assert.deepEqual(denied, { error: "login required" });
  const failed = await fetchCodexUsage(auth, signal, (async () => {
    throw new Error("sensitive token");
  }) as typeof fetch);
  assert.deepEqual(failed, { error: "usage check failed" });
});
test("traffic light colors use explicit RGB rather than theme colors", () => {
  assert.equal(colorize("ok", "healthy"), "\x1b[38;2;80;200;120mok\x1b[39m");
  assert.equal(colorize("low", "warning"), "\x1b[38;2;255;165;0mlow\x1b[39m");
  assert.equal(
    colorize("critical", "critical"),
    "\x1b[38;2;255;85;85mcritical\x1b[39m",
  );
});
test("quota colors use exact boundaries and worst window, not optional paid credits", () => {
  const snapshot = (remaining: number) => ({
    updatedAt: now,
    limits: [{ label: "5h", unit: "%" as const, remaining }],
  });
  for (const [remaining, expected] of [
    [100, "healthy"],
    [50, "healthy"],
    [49.9, "warning"],
    [25, "warning"],
    [24.9, "critical"],
    [0, "critical"],
  ] as const) {
    assert.equal(health(snapshot(remaining), now), expected);
  }
  assert.equal(
    health(
      {
        updatedAt: now,
        limits: [
          snapshot(99).limits[0],
          { label: "week", unit: "%", remaining: 10 },
        ],
      },
      now,
    ),
    "critical",
  );
  assert.equal(
    health(
      {
        updatedAt: now,
        limits: [
          snapshot(99).limits[0],
          { label: "credits", unit: "credits", remaining: 0 },
        ],
      },
      now,
    ),
    "healthy",
  );
  assert.equal(
    health(
      {
        updatedAt: now,
        limits: [
          { label: "energy", unit: "kWh", remaining: 4, percentRemaining: 40 },
        ],
      },
      now,
    ),
    "warning",
  );
  assert.equal(
    health({ ...snapshot(10), updatedAt: now - 180001 }, now),
    "unknown",
  );
  assert.equal(health(undefined, now), "unknown");
  assert.equal(
    health(
      {
        updatedAt: now,
        limits: [{ label: "energy", unit: "kWh", remaining: 4 }],
      },
      now,
    ),
    "unknown",
  );
});
