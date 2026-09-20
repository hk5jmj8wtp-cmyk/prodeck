/**
 * Which Planning Center plan the booth should be on.
 *
 * This is the logic that decides, without being asked, to switch the booth to
 * a different plan. It gets its own file because it was wrong in a way that
 * was invisible from the code: the two questions "is this plan old?" and "is
 * this plan in the list I happen to have loaded?" were answered by the same
 * `plans.find(...)`, and a plan that simply hadn't been fetched was treated as
 * a plan that had expired.
 *
 * What that cost, on a booth with 21 service types: choosing Candlelight
 * Christmas or Song Season loaded that type's plans, the plan selected a
 * moment earlier belonged to a different type and so wasn't among them, and
 * the app "helpfully" jumped months into the future. Reported as "I select a
 * service plan and it jumps to one way far in advance".
 */

export interface PlanLike {
  id: string;
  /** Planning Center's `dates` — DISPLAY text. Never do date maths on it. */
  date: string;
  /** Planning Center's `sort_date` — an ISO timestamp. The one to compute with. */
  sortDate?: string;
}

/**
 * How long after its date a plan still counts as current. A Sunday plan has to
 * stay selected through Sunday — the 11:00 service is still filed against the
 * same plan the 8:00 used — and through the Monday morning review.
 */
const FRESH_GRACE_MS = 36 * 3600_000;

/**
 * When a plan happens, in milliseconds, or NaN if we genuinely can't tell.
 *
 * Reads `sort_date` and only falls back to the display text. This ordering is
 * the fix for the bug that started this file, and it is not a style
 * preference: `dates` is prose written for humans, and JavaScript parses the
 * two-day form by taking the second day as a YEAR.
 *
 *   Date.parse("December 23 & 24, 2026")  ->  2024-12-23
 *   Date.parse("October 16 & 17, 2026")   ->  2017-10-16
 *
 * Silently, with no error. Every Christmas service and every conference was
 * therefore dated years in the past, counted as expired, and auto-targeted
 * away from the moment an operator selected it.
 */
function planTime(plan: PlanLike): number {
  const iso = Date.parse(plan.sortDate ?? "");
  return Number.isFinite(iso) ? iso : Date.parse(plan.date);
}

/**
 * Three answers, not two. `unknown` is the one the old code didn't have, and
 * is the whole point of this module: a date we can't read, or a plan we simply
 * don't have, is not evidence that the plan is over.
 */
export type Freshness = "fresh" | "stale" | "unknown";

export function freshness(plan: PlanLike | undefined, now: number): Freshness {
  if (!plan) return "unknown";
  const t = planTime(plan);
  if (!Number.isFinite(t)) return "unknown";
  return t >= now - FRESH_GRACE_MS ? "fresh" : "stale";
}

/**
 * Combine the pages of plans fetched for one service type into the list the
 * picker sees: de-duplicated by id, oldest first, undated plans last.
 */
export function mergePlanPages<T extends PlanLike>(pages: (T[] | null | undefined)[]): T[] {
  const byId = new Map<string, T>();
  for (const page of pages) {
    for (const plan of page ?? []) byId.set(plan.id, plan);
  }
  return [...byId.values()].sort((a, b) => {
    const at = planTime(a);
    const bt = planTime(b);
    const aok = Number.isFinite(at);
    const bok = Number.isFinite(bt);
    if (aok && bok) return at - bt;
    // A plan whose date we can't read sorts to the end rather than to 1970,
    // where it would otherwise win "earliest" and become the auto-target.
    if (aok !== bok) return aok ? -1 : 1;
    return a.date.localeCompare(b.date);
  });
}

/**
 * The plan to switch to, or `null` to leave the current selection alone.
 *
 * Switch only when there is positive evidence the current selection is done
 * with: no selection at all, or a selected plan we can see in the list and can
 * date as past. Anything else — a plan we don't have, a date we can't read —
 * leaves the operator's choice where they put it. Being slow to roll forward
 * costs someone one click on Monday; overriding a deliberate choice loses the
 * rundown out from under whoever is running the service.
 */
export function autoTargetPlan(
  plans: PlanLike[],
  selectedPlanId: string | null | undefined,
  now: number = Date.now(),
): string | null {
  const target = plans.find((p) => freshness(p, now) === "fresh");
  if (!target) return null;
  if (!selectedPlanId) return target.id;
  if (selectedPlanId === target.id) return null;

  const current = plans.find((p) => p.id === selectedPlanId);
  return freshness(current, now) === "stale" ? target.id : null;
}
