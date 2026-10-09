import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import usageBar from "../src/usage-bar/index.ts";

type Handler = (data: unknown, ctx: ExtensionContext) => unknown;
function harness(mode: "tui" | "print") {
  const hooks = new Map<string, Handler>();
  const events = new Map<string, (data: unknown) => void>();
  const requests: string[] = [];
  let widget: { render: (width: number) => string[] } | undefined;
  const context = {
    mode,
    // Deliberately unrelated model: all three providers must still be shown.
    model: { provider: "other" },
    getContextUsage: () => ({ tokens: 200, contextWindow: 1000, percent: 20 }),
    modelRegistry: { getProviderAuth: async () => undefined },
    ui: {
      setWidget: (
        _key: string,
        factory?: (tui: unknown, theme: unknown) => typeof widget,
      ) => {
        widget = factory?.(
          { requestRender() {} },
          { fg: (_color: string, value: string) => value },
        );
      },
    },
  } as unknown as ExtensionContext;
  const pi = {
    on: (name: string, handler: Handler) => hooks.set(name, handler),
    events: {
      on: (name: string, handler: (data: unknown) => void) => {
        events.set(name, handler);
        return () => events.delete(name);
      },
      emit: (name: string) => requests.push(name),
    },
  } as unknown as ExtensionAPI;
  usageBar(pi);
  return {
    hooks,
    events,
    requests,
    context,
    render: (width: number) => widget?.render(width),
  };
}

test("always visible on unrelated models, auto-refresh, wrapping and cleanup", async () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-usage-ext-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = directory;
  const h = harness("tui");
  try {
    h.hooks.get("session_start")?.({}, h.context);
    assert.match(
      h.render(200)?.join(" ") ?? "",
      /Codex:.*Synthetic:.*Neuralwatt:.*Claude:.*Claude 2:/,
    );
    assert.doesNotMatch(h.render(200)?.join(" ") ?? "", /Context:/);
    await delay(600);
    assert.deepEqual(h.requests.sort(), [
      "neuralwatt:quotas:request",
      "synthetic:quotas:request",
    ]);
    h.events.get("synthetic:quotas:updated")?.({
      quotas: { subscription: { limit: 100, requests: 10 } },
      updatedAt: Date.now(),
    });
    h.events.get("neuralwatt:quotas:updated")?.({
      source: "header",
      quotas: { balance: { credits_remaining_usd: 0 } },
    });
    assert.match(h.render(200)?.join(" ") ?? "", /Neuralwatt: unavailable/);
    h.events.get("neuralwatt:quotas:updated")?.({
      source: "api",
      quotas: { balance: { credits_remaining_usd: 42 } },
    });
    const rendered = h.render(200)?.join(" ") ?? "";
    assert.match(rendered, /Codex: login required/);
    assert.match(rendered, /Claude: login required/);
    assert.match(rendered, /Synthetic: requests 90% left/);
    // credits are filtered out, Neuralwatt shows "no limits" when only credits remain
    assert.match(rendered, /Neuralwatt: no limits/);
    for (const width of [1, 10, 40, 80, 200]) {
      for (const line of h.render(width) ?? [])
        assert.ok(visibleWidth(line) <= width);
    }
    assert.deepEqual(h.render(0), []);
  } finally {
    h.hooks.get("session_shutdown")?.({}, h.context);
    assert.equal(h.events.size, 0);
    assert.equal(h.render(100), undefined);
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    rmSync(directory, { recursive: true, force: true });
  }
});
test("noninteractive sessions do not render or request quotas", async () => {
  const h = harness("print");
  h.hooks.get("session_start")?.({}, h.context);
  await delay(600);
  assert.deepEqual(h.requests, []);
  assert.equal(h.render(100), undefined);
  h.hooks.get("session_shutdown")?.({}, h.context);
});
