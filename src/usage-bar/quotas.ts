export const providers = ["codex", "neuralwatt", "claude2"] as const;
export type Provider = (typeof providers)[number];
export interface Limit {
  label: string;
  remaining: number;
  percentRemaining?: number;
  unit: "%" | "$" | "kWh" | "credits";
  at?: number;
  renewal?: "reset";
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
// Once the included energy is gone, Neuralwatt bills overage from the credit
// balance up to the monthly spending limit (`overage_limit_usd`). A null limit
// counts as no limit and zero as overage off. The quota API reports no overage
// spend, so the budget is an upper bound; Neuralwatt enforces the limit.
function overage(q: Record<string, unknown>): Limit | undefined {
  const balance = object(q.balance);
  const credits = number(balance.credits_remaining_usd);
  const cap = object(q.limits).overage_limit_usd;
  const ceiling = cap === null ? Number.POSITIVE_INFINITY : number(cap);
  if (credits === undefined || ceiling === undefined || ceiling <= 0) return;
  const remaining = Math.max(0, Math.min(credits, ceiling));
  return {
    label: "extra",
    remaining,
    unit: "$",
    percentRemaining: percent(
      remaining,
      cap === null ? balance.total_credits_usd : cap,
    ),
  };
}
function energy(q: Record<string, unknown>): Limit | undefined {
  const subscription = object(q.subscription);
  const remaining = number(subscription.kwh_remaining);
  if (remaining === undefined) return;
  const renewal = {
    at: date(subscription.current_period_end),
    renewal: "reset" as const,
  };
  const extra = remaining <= 0 ? overage(q) : undefined;
  if (extra) return { ...extra, ...renewal };
  return {
    label: "energy",
    remaining,
    percentRemaining: percent(
      Math.max(0, remaining),
      subscription.kwh_included,
    ),
    unit: "kWh",
    ...renewal,
  };
}
export function neuralwatt(
  value: unknown,
  now = Date.now(),
): Snapshot | undefined {
  const q = object(value);
  const limits: Limit[] = [];
  const included = energy(q);
  if (included) limits.push(included);
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
        (l.renewal === undefined || l.renewal === "reset")
      );
    })
  );
}
