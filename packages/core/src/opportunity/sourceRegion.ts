/**
 * WHERE THE CARD IS COMING FROM.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHY THIS IS AN ECONOMICS FILTER, NOT A CONVENIENCE ONE.
 *
 * `importTax` and `acquisitionFees` default to £0 for every opportunity in
 * this app — nothing in the scan pipeline populates them (see
 * ARCHITECTURE.md's own note, and the warning banner the detail page already
 * shows). For a UK buyer that assumption is exactly right on a UK listing
 * and wrong on every other one, where customs duty, import VAT and the
 * courier's handling fee all land after the number on screen was computed.
 *
 * The live feed on 2026-09-13:
 *
 *   US 36,508 · GB 9,193 · CA 3,985 · AU 637 · IT 494 · DE 206 · IE 114 …
 *
 * Seventeen percent of what the operator was looking at was UK stock. Every
 * other row understated its delivered cost by an unmodelled amount, and
 * therefore overstated profit at every grade on the ladder.
 *
 * So this filter is the one control that makes the delivered-cost figure
 * mean what it says. It is not a shipping-speed preference.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * AND WHY "EUROPE" IS NOT "NO IMPORT COST".
 *
 * Post-Brexit, an EU seller shipping to the UK is an import like any other:
 * VAT at the border, potentially duty, usually a handling fee. UK_EU is
 * offered because a European seller is still faster, cheaper to return to
 * and easier to deal with than a US one — NOT because it is duty-free. Only
 * UK_ONLY has no unmodelled import cost, and the UI must say so rather than
 * let the grouping imply it.
 */

export type SourceRegion = "ANY" | "UK_ONLY" | "UK_EU";

/**
 * The single country whose listings carry no unmodelled import cost for a
 * UK buyer. Kept as its own constant because several places need to ask
 * "is this the domestic one?" and none of them should hardcode "GB".
 */
export const DOMESTIC_COUNTRY = "GB";

/**
 * Europe as ISO 3166-1 alpha-2, EU plus the nearby non-EU countries a UK
 * buyer realistically buys from (NO, CH, IS).
 *
 * Deliberately a fixed geographic list rather than "whatever countries are
 * currently in the table". A region filter that quietly changes meaning as
 * new sellers appear is not a filter, and a country that shows up next week
 * would otherwise be silently excluded from a set the operator believes is
 * complete.
 */
export const EUROPE_COUNTRIES: readonly string[] = [
  "AT", "BE", "BG", "CH", "CY", "CZ", "DE", "DK", "EE", "ES", "FI", "FR",
  "GR", "HR", "HU", "IE", "IS", "IT", "LT", "LU", "LV", "MT", "NL", "NO",
  "PL", "PT", "RO", "SE", "SI", "SK",
];

/**
 * The ISO country codes a region admits, or null for "no restriction".
 *
 * Null rather than an all-countries list on purpose: the caller then emits
 * no SQL clause at all, so the default view is byte-for-byte the query it
 * always was, and a country the list has never heard of is not excluded by
 * an accident of omission.
 */
export function countriesForRegion(region: SourceRegion): readonly string[] | null {
  switch (region) {
    case "UK_ONLY":
      return [DOMESTIC_COUNTRY];
    case "UK_EU":
      return [DOMESTIC_COUNTRY, ...EUROPE_COUNTRIES];
    case "ANY":
    default:
      return null;
  }
}

/**
 * True when this listing's country carries import costs the app does not
 * model. A null country is NOT treated as domestic — unknown is unknown, and
 * assuming "probably local" is how an unmodelled cost becomes an invisible
 * one.
 */
export function hasUnmodelledImportCost(country: string | null | undefined): boolean {
  return country !== DOMESTIC_COUNTRY;
}
