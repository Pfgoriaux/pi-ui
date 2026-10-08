import { homedir } from "node:os";
import { join } from "node:path";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { Cache } from "./cache.ts";
import { fetchClaudeUsage } from "./claude.ts";
import { fetchCodexUsage } from "./codex.ts";
import { colorize, describe, health, names } from "./display.ts";
import { installContextColor } from "./footer.ts";
import {
  neuralwatt,
  object,
  type Provider,
  providers,
  type Snapshot,
  synthetic,
} from "./quotas.ts";

// Providers polled directly over HTTP vs those fed by quota events.
type FetchProvider = "codex" | "claude";
function isFetchProvider(provider: Provider): provider is FetchProvider {
  return provider === "codex" || provider === "claude";
}
// Minimum seconds of snapshot freshness. Claude's usage endpoint is rate
// limited per access token (~5 requests); community-observed safe cadence is
// >=180s (anthropic/claude-code#31637).
const minInterval: Record<Provider, number> = {
  codex: 60_000,
  synthetic: 60_000,
  neuralwatt: 60_000,
  claude: 180_000,
};

export default function usageBar(pi: ExtensionAPI): void {
  const agentDir =
    process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
  const cache = new Cache(join(agentDir, "cache", "usage-bar"));
  const snapshots: Partial<Record<Provider, Snapshot>> = {};
  let ctx: ExtensionContext | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  let startTimer: ReturnType<typeof setTimeout> | undefined;
  let repaint: (() => void) | undefined;
  let cacheFailed = false;
  let restoreFooter: (() => void) | undefined;
  const requests: Partial<Record<FetchProvider, AbortController>> = {};
  const errors: Partial<Record<FetchProvider, string>> = {};

  const refresh = async (
    provider: FetchProvider,
    context: ExtensionContext,
  ) => {
    if (requests[provider]) return;
    const controller = new AbortController();
    requests[provider] = controller;
    try {
      const fetcher = provider === "codex" ? fetchCodexUsage : fetchClaudeUsage;
      const providerName = provider === "codex" ? "openai-codex" : "anthropic";
      const result = await fetcher(
        () => context.modelRegistry.getProviderAuth(providerName),
        controller.signal,
      );
      if (controller.signal.aborted || ctx !== context) return;
      if ("snapshot" in result) ingest(provider, result.snapshot);
      else errors[provider] = result.error;
      repaint?.();
    } finally {
      if (requests[provider] === controller) requests[provider] = undefined;
    }
  };

  const ingest = (provider: Provider, snapshot: Snapshot | undefined) => {
    if (!ctx || !snapshot) return;
    if (snapshot.updatedAt < (snapshots[provider]?.updatedAt ?? 0)) return;
    snapshots[provider] = snapshot;
    cacheFailed = !cache.write(provider, snapshot);
    repaint?.();
  };
  const unsubscribers = [
    pi.events.on("synthetic:quotas:updated", (payload: unknown) => {
      const data = object(payload);
      const at =
        typeof data.updatedAt === "number" && Number.isFinite(data.updatedAt)
          ? Math.min(Date.now(), data.updatedAt)
          : Date.now();
      ingest("synthetic", synthetic(data.quotas, at));
    }),
    pi.events.on("neuralwatt:quotas:updated", (payload: unknown) => {
      const data = object(payload);
      // Header-derived events contain synthetic zero balances. Only the quota API
      // snapshot is authoritative for the combined energy + credit + key display.
      if (data.source === "api") ingest("neuralwatt", neuralwatt(data.quotas));
    }),
  ];
  const tick = () => {
    if (!ctx) return;
    const now = Date.now();
    for (const provider of providers) {
      const shared = cache.read(provider);
      if (shared && shared.updatedAt > (snapshots[provider]?.updatedAt ?? 0))
        snapshots[provider] = shared;
    }
    repaint?.();
    for (const provider of providers) {
      if (now - (snapshots[provider]?.updatedAt ?? 0) < minInterval[provider])
        continue;
      if (isFetchProvider(provider)) {
        if (requests[provider]) continue;
        if (!cache.claim(provider, now)) continue;
        void refresh(provider, ctx);
      } else {
        if (!cache.claim(provider, now)) continue;
        pi.events.emit(`${provider}:quotas:request`, {});
      }
    }
  };

  pi.on("session_start", (_event, context) => {
    if (context.mode !== "tui") return;
    ctx = context;
    restoreFooter = installContextColor(() => context.getContextUsage());
    context.ui.setWidget(
      "usage-bar",
      (tui, theme) => {
        repaint = () => tui.requestRender();
        return {
          render(width: number): string[] {
            if (width <= 0) return [];
            const now = Date.now();
            const segments = providers.map((provider) => {
              const snapshot = snapshots[provider];
              const state = health(snapshot, now);
              const text =
                isFetchProvider(provider) && !snapshot
                  ? `${names[provider]}: ${errors[provider] ?? "checking usage"}`
                  : describe(provider, snapshot, now);
              return colorize(text, state);
            });
            if (cacheFailed)
              segments.push(theme.fg("warning", "quota cache unavailable"));
            return wrapTextWithAnsi(segments.join("  |  "), width);
          },
          invalidate() {},
        };
      },
      { placement: "belowEditor" },
    );
    // Wait until all provider session_start handlers have captured their registry.
    startTimer = setTimeout(tick, 500);
    timer = setInterval(tick, 5000);
    startTimer.unref();
    timer.unref();
  });

  pi.on("session_shutdown", () => {
    if (startTimer) clearTimeout(startTimer);
    if (timer) clearInterval(timer);
    for (const provider of ["codex", "claude"] as const)
      requests[provider]?.abort();
    restoreFooter?.();
    for (const unsubscribe of unsubscribers) unsubscribe();
    ctx?.ui.setWidget("usage-bar", undefined);
    ctx = undefined;
    repaint = undefined;
  });
}
