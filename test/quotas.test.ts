import assert from "node:assert/strict";
import { test } from "node:test";
import { describe, health } from "../src/usage-bar/display.ts";
import {
  neuralwatt,
  synthetic,
  validSnapshot,
} from "../src/usage-bar/quotas.ts";

const now = Date.now();
test("Synthetic rolling and weekly quota retain refill semantics", () => {
  const snapshot = synthetic(
    {
      rollingFiveHourLimit: {
        remaining: 40,
        max: 100,
        nextTickAt: new Date(now + 60000).toISOString(),
      },
      weeklyTokenLimit: {
        percentRemaining: 12.5,
        nextRegenAt: new Date(now + 120000).toISOString(),
      },
    },
    now,
  );
  assert.equal(snapshot?.limits[0].remaining, 40);
  assert.equal(snapshot?.limits[1].remaining, 12.5);
  assert.match(describe("synthetic", snapshot, now), /refill 1m/);
  assert.match(describe("synthetic", snapshot, now), /week 12% left/);
});
test("fresh Synthetic readings remain colored when refill timestamps are past", () => {
  const snapshot = synthetic(
    {
      rollingFiveHourLimit: {
        remaining: 100,
        max: 100,
        nextTickAt: new Date(now - 60000).toISOString(),
      },
      weeklyTokenLimit: {
        percentRemaining: 57,
        nextRegenAt: new Date(now - 60000).toISOString(),
      },
    },
    now,
  );
  assert.equal(health(snapshot, now), "healthy");
  assert.doesNotMatch(describe("synthetic", snapshot, now), /refresh due/);
  assert.match(
    describe("synthetic", snapshot, now),
    /week 57% left \(refill pending\)/,
  );
  assert.equal(health(snapshot, now + 180001), "unknown");
});

test("legacy requests, exhausted, and malformed values are distinct", () => {
  assert.equal(
    synthetic({ subscription: { limit: 100, requests: 25 } })?.limits[0]
      .remaining,
    75,
  );
  assert.equal(
    synthetic({ subscription: { limit: 100, requests: 120 } })?.limits[0]
      .remaining,
    0,
  );
  for (const input of [
    null,
    {},
    { subscription: { limit: 0, requests: 0 } },
    { weeklyTokenLimit: { percentRemaining: Number.NaN } },
  ]) {
    assert.equal(synthetic(input), undefined);
  }
});
test("Neuralwatt keeps energy and credits in their actual units", () => {
  const snapshot = neuralwatt(
    {
      subscription: {
        kwh_remaining: 0.42,
        current_period_end: new Date(now + 3600000).toISOString(),
      },
      balance: { credits_remaining_usd: 9.5 },
      key: { allowance: { remaining_usd: 2, blocked: true } },
    },
    now,
  );
  assert.deepEqual(
    snapshot?.limits.map((l) => [l.remaining, l.unit]),
    [
      [0.42, "kWh"],
      [9.5, "$"],
      [0, "$"],
    ],
  );
  // credits are filtered out of display, only energy shown
  assert.match(describe("neuralwatt", snapshot, now), /energy 0.42kWh left/);
  assert.equal(neuralwatt({}), undefined);
});
test("missing data is unknown, never fabricated remaining credits", () => {
  assert.match(describe("codex", undefined), /unavailable/);
  assert.match(describe("neuralwatt", undefined), /unavailable/);
});
test("old snapshots stay stale even after resets", () => {
  const snapshot = {
    updatedAt: now - 600000,
    limits: [{ label: "5h", remaining: 0, unit: "%" as const, at: now - 1000 }],
  };
  assert.match(
    describe("codex", snapshot, now),
    /0% left \(refresh due\).*stale 10m/,
  );
});
test("disk snapshot validator rejects control text, nonfinite and future data", () => {
  assert.equal(
    validSnapshot({
      updatedAt: now,
      limits: [{ label: "\x1b[31m", unit: "%", remaining: 1 }],
    }),
    false,
  );
  assert.equal(
    validSnapshot({
      updatedAt: now,
      limits: [{ label: "5h", unit: "%", remaining: Infinity }],
    }),
    false,
  );
  assert.equal(
    validSnapshot({
      updatedAt: now + 90000,
      limits: [{ label: "5h", unit: "%", remaining: 1 }],
    }),
    false,
  );
});
