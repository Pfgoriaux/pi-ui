import assert from "node:assert/strict";
import { test } from "node:test";
import { describe, health } from "../src/usage-bar/display.ts";
import { neuralwatt, validSnapshot } from "../src/usage-bar/quotas.ts";

const now = Date.now();
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
test("Neuralwatt energy shows the share of the included kWh", () => {
  const snapshot = neuralwatt(
    { subscription: { kwh_remaining: 21.91, kwh_included: 30 } },
    now,
  );
  assert.match(
    describe("neuralwatt", snapshot, now),
    /energy 21.91kWh \(73%\) left/,
  );
});
function exhausted(cap: unknown, credits = 51.2569) {
  return neuralwatt(
    {
      subscription: {
        kwh_remaining: 0,
        kwh_included: 28.5714,
        current_period_end: new Date(now + 3600000).toISOString(),
      },
      balance: { credits_remaining_usd: credits, total_credits_usd: 55 },
      limits: { overage_limit_usd: cap },
    },
    now,
  );
}
test("Neuralwatt shows the overage budget once the included energy is gone", () => {
  const snapshot = exhausted(200);
  assert.deepEqual(
    snapshot?.limits.map((l) => [l.label, l.remaining, l.unit]),
    [
      ["extra", 51.2569, "$"],
      ["credits", 51.2569, "$"],
    ],
  );
  assert.match(
    describe("neuralwatt", snapshot, now),
    /^Neuralwatt: extra \$51\.26 \(25%\) left \(reset 1h0m\)$/,
  );
  assert.equal(health(snapshot, now), "warning");
  assert.equal(exhausted(20)?.limits[0].remaining, 20);
  assert.equal(health(exhausted(200, 0), now), "critical");
});
test("Neuralwatt without a spending limit measures overage against credits", () => {
  assert.equal(
    Math.floor(exhausted(null)?.limits[0].percentRemaining ?? 0),
    93,
  );
});
test("Neuralwatt energy stays exhausted when overage is off or unknown", () => {
  for (const cap of [0, undefined]) {
    const snapshot = exhausted(cap);
    assert.equal(snapshot?.limits[0].label, "energy");
    assert.equal(health(snapshot, now), "critical");
  }
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
  assert.equal(
    validSnapshot({
      updatedAt: now,
      limits: [{ label: "5h", unit: "%", remaining: 1, renewal: "refill" }],
    }),
    false,
  );
});
