import assert from "node:assert/strict";
import { test } from "node:test";
import { describe } from "../src/usage-bar/display.ts";
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
