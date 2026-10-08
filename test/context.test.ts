import assert from "node:assert/strict";
import { test } from "node:test";
import { FooterComponent } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
  colorize,
  contextHealth,
  type QuotaHealth,
} from "../src/usage-bar/display.ts";
import {
  colorContextLine,
  installContextColor,
} from "../src/usage-bar/footer.ts";

test("context colors use remaining capacity at 75% and 50% boundaries", () => {
  const cases: [number, QuotaHealth][] = [
    [0, "healthy"],
    [25, "healthy"],
    [25.01, "warning"],
    [50, "warning"],
    [50.01, "critical"],
    [100, "critical"],
    [110, "critical"],
  ];
  for (const [percent, state] of cases) {
    assert.equal(
      contextHealth({ tokens: percent * 10, contextWindow: 1000, percent }),
      state,
    );
  }
});

test("unknown context after compaction is not presented as empty", () => {
  for (const usage of [
    undefined,
    { tokens: null, contextWindow: 1000, percent: null },
    { tokens: 0, contextWindow: 0, percent: 0 },
    { tokens: 10, contextWindow: 1000, percent: Number.NaN },
  ])
    assert.equal(contextHealth(usage), "unknown");
});

test("native context color preserves tokens, cache hit rate, cost and layout", () => {
  const before = "↑588k ↓73k R12M CH99.0% $14.867 (sub) ";
  const after = " (auto)          (openai-codex) model • medium";
  const line = `${before}51.2%/272k${after}`;
  const output = colorContextLine(line, {
    tokens: 139264,
    contextWindow: 272000,
    percent: 51.2,
  });
  assert.equal(output, before + colorize("51.2%/272k", "critical") + after);
  assert.equal(visibleWidth(output), visibleWidth(line));
  assert.equal(colorContextLine("CH99.0%", undefined), "CH99.0%");
  assert.equal(
    colorContextLine("?/272k (auto)", undefined),
    `${colorize("?/272k", "unknown")} (auto)`,
  );
});

test("native footer decoration is removable and never replaces other rows", () => {
  const native = FooterComponent.prototype.render;
  const stub = () => ["~/eden", "51.2%/272k (auto)", "other extension status"];
  FooterComponent.prototype.render = stub;
  const remove = installContextColor(() => ({
    tokens: 139264,
    contextWindow: 272000,
    percent: 51.2,
  }));
  try {
    const footer = Object.create(FooterComponent.prototype) as FooterComponent;
    const rows = footer.render(120);
    assert.equal(rows[0], "~/eden");
    assert.equal(rows[2], "other extension status");
    assert.equal(rows[1], `${colorize("51.2%/272k", "critical")} (auto)`);
    remove();
    assert.equal(FooterComponent.prototype.render, stub);
    assert.deepEqual(footer.render(120), stub());
  } finally {
    remove();
    FooterComponent.prototype.render = native;
  }
});
