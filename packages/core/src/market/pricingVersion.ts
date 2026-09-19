/**
 * WHICH PRICING RULE A STORED PROFILE WAS COMPUTED UNDER.
 *
 * THE PROBLEM THIS SOLVES. Market profiles are recomputed on an age window —
 * twelve hours for a card in the eligible universe, a fortnight for the rest
 * (see MarketProviderBudgetSettings.ineligibleRefreshHours). That is the
 * right cadence for tracking a moving market. It is the wrong cadence
 * entirely for a change in HOW a price is derived, because such a change
 * applies to every card at once and retroactively: the numbers already in
 * the database were computed by rules that no longer exist.
 *
 * Live, on 2026-09-13, that produced the worst possible outcome. A fix to
 * slab pricing had been written, tested, merged and deployed the day before,
 * and every figure on screen was still the old one — the profiles simply had
 * not aged out yet. The code was correct and the product was wrong, with
 * nothing anywhere to say so. Verifying the fix required reading a stored
 * provider payload and dividing by the FX rate by hand.
 *
 * THE RULE. Bump this string whenever a change alters the NUMBER a given
 * provider payload produces — the statistic a tier is priced from, the FX
 * treatment, a haircut, the QSV derivation. Every profile carrying a
 * different stamp is then due for recomputation immediately, ahead of its
 * age window, and the fix reaches the screen because it was deployed rather
 * than because enough hours went by.
 *
 * Do NOT bump it for a change that cannot move a number: a comment, a
 * rename, a display change, a new column that nothing reads yet. A needless
 * bump re-profiles the whole catalogue and spends the day's provider budget
 * on work with no result.
 *
 * The value is a date plus a short slug. It is compared for equality only —
 * never parsed, never ordered — so the format is for humans reading a row
 * and asking "which rules made this?".
 */
export const MARKET_PRICING_VERSION = "2026-09-13.lowest-window";

/**
 * True when a stored profile predates the current pricing rules and must be
 * recomputed regardless of how recently it was written.
 *
 * A null stamp means the profile was written before stamping existed, which
 * is the strongest possible signal that it is out of date.
 */
export function isPricingStale(storedVersion: string | null | undefined): boolean {
  return storedVersion !== MARKET_PRICING_VERSION;
}
