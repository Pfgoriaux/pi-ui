import type { ContextUsage } from "@earendil-works/pi-coding-agent";
import type { Provider, Snapshot } from "./quotas.ts";
export const names: Record<Provider, string> = {
  codex: "Codex",
  synthetic: "Synthetic",
  neuralwatt: "Neuralwatt",
  claude: "Claude",
  claude2: "Claude 2",
};
export type QuotaHealth = "healthy" | "warning" | "critical" | "unknown";
export function health(
  snapshot: Snapshot | undefined,
  now = Date.now(),
): QuotaHealth {
  if (
    !snapshot ||
    now - snapshot.updatedAt > 180_000 ||
    snapshot.limits.some(
      (l) => l.renewal !== "refill" && l.at !== undefined && l.at <= now,
    )
  )
    return "unknown";
  const percentages = snapshot.limits.flatMap((l) => {
    const percent = l.unit === "%" ? l.remaining : l.percentRemaining;
    // Paid Codex credits are optional fallback, not a quota window.
    if (percent !== undefined) return [percent];
    return l.unit !== "credits" && l.remaining <= 0 ? [0] : [];
  });
  if (!percentages.length) return "unknown";
  const lowest = Math.min(...percentages);
  return lowest < 25 ? "critical" : lowest < 50 ? "warning" : "healthy";
}
export function colorize(text: string, state: QuotaHealth): string {
  // Explicit RGB avoids themes mapping success/error to unrelated colors.
  const rgb = {
    healthy: "80;200;120",
    warning: "255;165;0",
    critical: "255;85;85",
    unknown: "140;140;140",
  }[state];
  return `\x1b[38;2;${rgb}m${text}\x1b[39m`;
}
export function contextHealth(usage: ContextUsage | undefined): QuotaHealth {
  if (
    !usage ||
    usage.tokens === null ||
    usage.percent === null ||
    !Number.isFinite(usage.percent) ||
    usage.percent < 0 ||
    !Number.isFinite(usage.contextWindow) ||
    usage.contextWindow <= 0
  ) {
    return "unknown";
  }
  const remaining = Math.max(0, 100 - usage.percent);
  const state =
    remaining < 50 ? "critical" : remaining < 75 ? "warning" : "healthy";
  return state;
}
export function duration(ms: number): string {
  const minutes = Math.max(1, Math.ceil(ms / 60_000));
  if (minutes < 60) return `${minutes}m`;
  if (minutes < 1440) return `${Math.floor(minutes / 60)}h${minutes % 60}m`;
  return `${Math.floor(minutes / 1440)}d${Math.floor((minutes % 1440) / 60)}h`;
}
// Filter out credits and scoped model weeks (fableweek, opus48week, etc.)
function filterLimits(limits: Snapshot["limits"]): Snapshot["limits"] {
  return limits.filter((limit) => {
    // Skip credits (unit $ or credits)
    if (limit.unit === "$" || limit.unit === "credits") return false;
    // Skip scoped model weeks (ends with "week" but isn't just "week")
    if (limit.label.endsWith("week") && limit.label !== "week") return false;
    return true;
  });
}

export function describe(
  provider: Provider,
  snapshot: Snapshot | undefined,
  now = Date.now(),
): string {
  if (!snapshot) return `${names[provider]}: unavailable`;
  const stale = now - snapshot.updatedAt > 180_000;
  const filtered = filterLimits(snapshot.limits);
  if (filtered.length === 0) return `${names[provider]}: no limits`;
  const items = filtered.map((limit) => {
    const value =
      limit.unit === "$"
        ? `$${limit.remaining.toFixed(2)}`
        : limit.unit === "%"
          ? `${Math.floor(limit.remaining)}%`
          : limit.unit === "credits"
            ? `${limit.remaining.toFixed(2)}`
            : `${limit.remaining.toFixed(2)}kWh`;
    const reset =
      limit.at === undefined
        ? ""
        : limit.at <= now
          ? limit.renewal === "refill"
            ? limit.unit === "%" && limit.remaining >= 100
              ? ""
              : " (refill pending)"
            : " (refresh due)"
          : ` (${limit.renewal ?? "reset"} ${duration(limit.at - now)})`;
    return `${limit.label} ${value} left${reset}`;
  });
  return `${names[provider]}: ${items.join(" / ")}${stale ? ` [stale ${duration(now - snapshot.updatedAt)}]` : ""}`;
}
