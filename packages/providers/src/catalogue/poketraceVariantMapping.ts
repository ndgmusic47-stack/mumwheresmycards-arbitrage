import type { Edition, Finish, Variant } from "@mwmc/core";

/**
 * PokeTrace's `variant` enum, per its OpenAPI spec's `GET /cards` query
 * parameter documentation. Exactly these 6 values are defined — there is
 * no 7th value for anything vintage-specific.
 */
export type PokeTraceVariant = "Normal" | "Holofoil" | "Reverse_Holofoil" | "1st_Edition" | "1st_Edition_Holofoil" | "Unlimited";

export interface MappedVariantIdentity {
  edition: Edition;
  variant: Variant;
  finish: Finish;
}

/**
 * KNOWN GAP: PokeTrace's variant enum has no concept of "shadowless" at
 * all, so Base-Set-era cards that had both a shadowless and an
 * unlimited-shadow print run can NEVER be distinguished from catalogue
 * data alone — every mapping below returns `finish: "na"`. The only place
 * that can add 'shadowless'/'unlimited_shadow' is eBay-listing-title
 * reconciliation (apps/worker/src/scan/titleParser.ts), and only when the
 * seller actually wrote it in the title. Absent that, such listings
 * correctly stay identity-unresolved (REJECTED_CARD_IDENTITY_UNCERTAIN)
 * rather than being guessed — consistent with this project's "never guess
 * identity" rule. See ARCHITECTURE.md for the full explanation and the
 * follow-up (a dedicated known-split-print-run reference table) needed to
 * close this gap properly.
 *
 * Returns null for a provider variant string outside the 6 documented
 * values — the caller should skip/flag the card rather than guess.
 */
export function mapPokeTraceVariant(providerVariant: string | null): MappedVariantIdentity | null {
  switch (providerVariant as PokeTraceVariant | null) {
    case "Normal":
      return { edition: "na", variant: "normal", finish: "na" };
    case "Holofoil":
      return { edition: "na", variant: "holo", finish: "na" };
    case "Reverse_Holofoil":
      return { edition: "na", variant: "reverse_holo", finish: "na" };
    case "1st_Edition":
      return { edition: "1st", variant: "normal", finish: "na" };
    case "1st_Edition_Holofoil":
      return { edition: "1st", variant: "holo", finish: "na" };
    case "Unlimited":
      return { edition: "unlimited", variant: "normal", finish: "na" };
    default:
      return null;
  }
}
