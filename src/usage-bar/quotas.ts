export const providers = [
  "codex",
  "synthetic",
  "neuralwatt",
  "claude",
] as const;
export type Provider = (typeof providers)[number];
export interface Limit {
  label: string;
  remaining: number;
  percentRemaining?: number;
  unit: "%" | "$" | "kWh" | "credits";
  at?: number;
  renewal?: "reset" | "refill";
}
export interface Snapshot {
  updatedAt: number;
  limits: Limit[];
}
export function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
function number(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}
function date(value: unknown): number | undefined {
  const result = typeof value === "string" ? Date.parse(value) : Number.NaN;
  return Number.isFinite(result) ? result : undefined;
}
function percent(remaining: unknown, total: unknown): number | undefined {
  const r = number(remaining);
  const t = number(total);
  return r !== undefined && t !== undefined && t > 0 && r >= 0
    ? Math.min(100, (100 * r) / t)
    : undefined;
}
function result(limits: Limit[], now: number): Snapshot | undefined {
  return limits.length ? { updatedAt: now, limits } : undefined;
}
export function synthetic(
  value: unknown,
  now = Date.now(),
): Snapshot | undefined {
  const q = object(value);
  const limits: Limit[] = [];
  const rolling = object(q.rollingFiveHourLimit);
  const subscription = object(q.subscription);
  const remaining = percent(rolling.remaining, rolling.max);
  if (remaining !== undefined) {
    limits.push({
      label: "5h",
      remaining,
      unit: "%",
      at: date(rolling.nextTickAt),
      renewal: "refill",
    });
  } else {
    const total = number(subscription.limit);
    const used = number(subscription.requests);
    const left =
      total !== undefined && used !== undefined && used >= 0
        ? percent(Math.max(0, total - used), total)
        : undefined;
    if (left !== undefined)
      limits.push({
        label: "requests",
        remaining: left,
        unit: "%",
        at: date(subscription.renewsAt),
        renewal: "reset",
      });
  }
  const weekly = object(q.weeklyTokenLimit);
  const week = number(weekly.percentRemaining);
  if (week !== undefined && week >= 0 && week <= 100) {
    limits.push({
      label: "week",
      remaining: week,
      unit: "%",
      at: date(weekly.nextRegenAt),
      renewal: "refill",
    });
  }
  return result(limits, now);
}
export function neuralwatt(
  value: unknown,
  now = Date.now(),
): Snapshot | undefined {
  const q = object(value);
  const limits: Limit[] = [];
  const subscription = object(q.subscription);
  const energy = number(subscription.kwh_remaining);
  if (energy !== undefined)
    limits.push({
      label: "energy",
      remaining: energy,
      percentRemaining: percent(Math.max(0, energy), subscription.kwh_included),
      unit: "kWh",
      at: date(subscription.current_period_end),
      renewal: "reset",
    });
  const balance = number(object(q.balance).credits_remaining_usd);
  if (balance !== undefined)
    limits.push({
      label: "credits",
      remaining: balance,
      unit: "$",
      percentRemaining: percent(
        Math.max(0, balance),
        object(q.balance).total_credits_usd,
      ),
    });
  const allowance = object(object(q.key).allowance);
  const keyLeft = number(allowance.remaining_usd);
  if (keyLeft !== undefined)
    limits.push({
      label: "key",
      remaining: allowance.blocked === true ? 0 : keyLeft,
      percentRemaining: percent(
        allowance.blocked === true ? 0 : Math.max(0, keyLeft),
        allowance.limit_usd,
      ),
      unit: "$",
    });
  return result(limits, now);
}
export function validSnapshot(
  value: unknown,
  now = Date.now(),
): value is Snapshot {
  const s = object(value);
  return (
    typeof s.updatedAt === "number" &&
    Number.isFinite(s.updatedAt) &&
    s.updatedAt > 0 &&
    s.updatedAt <= now + 5000 &&
    Array.isArray(s.limits) &&
    s.limits.length > 0 &&
    s.limits.length <= 5 &&
    s.limits.every((raw: unknown) => {
      const l = object(raw);
      return (
        typeof l.label === "string" &&
        /^[a-z0-9]{1,16}$/.test(l.label) &&
        number(l.remaining) !== undefined &&
        (l.percentRemaining === undefined ||
          (number(l.percentRemaining) !== undefined &&
            Number(l.percentRemaining) >= 0 &&
            Number(l.percentRemaining) <= 100)) &&
        ["%", "$", "kWh", "credits"].includes(String(l.unit)) &&
        (l.unit !== "%" ||
          (Number(l.remaining) >= 0 && Number(l.remaining) <= 100)) &&
        (l.at === undefined ||
          (number(l.at) !== undefined && Number(l.at) > 0)) &&
        (l.renewal === undefined ||
          l.renewal === "reset" ||
          l.renewal === "refill")
      );
    })
  );
}
