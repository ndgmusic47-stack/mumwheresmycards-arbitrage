import type { Game, Edition, Finish, Variant } from "@mwmc/core";
import { mapPokeTraceVariant, type MappedVariantIdentity } from "./poketraceVariantMapping.js";

/**
 * VARIANT MAPPING, PER GAME.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * THE BUG THIS CLOSES. `catalogueSync.processCard` called
 * `mapPokeTraceVariant` on EVERY card from EVERY provider. With one
 * provider that was merely misnamed. With two it is a defect: One Piece's
 * printing strings are not in PokeTrace's six-value enum, so every One
 * Piece card would map to null and be skipped, and the sync would report a
 * clean run that catalogued nothing.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHY UNKNOWN STILL MEANS SKIP.
 *
 * Returning null for an unrecognised string is the existing rule and it
 * survives here unchanged. A variant is not decoration: for Pokémon it
 * separates a 1st Edition holo from an unlimited copy worth a fraction as
 * much, and for One Piece it separates a parallel/alternate art from the
 * base card on the same axis. Mapping an unknown string onto "normal" to
 * keep the card would put the cheap printing's price on the expensive
 * printing's row, which is the identity collapse this project has already
 * spent days chasing.
 *
 * The cost is visible rather than silent: the sync counts skips, so a
 * provider whose vocabulary we have not learned shows up as a large skip
 * count on a run, not as an empty catalogue nobody can explain.
 */
export type { MappedVariantIdentity };

/**
 * The printing axis most non-Pokémon TCGs expose, which is far coarser than
 * Pokémon's. JustTCG and TCG API both reduce it to roughly Normal/Foil,
 * with the interesting rarities (parallel, alternate art, manga art) living
 * in the RARITY field rather than the printing field.
 *
 * That has a consequence worth stating plainly rather than discovering
 * later: for these games `finish` and `edition` are always "na", so two
 * printings that differ only by something the provider encodes in rarity
 * will hash to the SAME card. Rarity is deliberately not part of the
 * printing hash (it is descriptive, and PokeTrace's own rarity strings are
 * unstable), and adding it would re-hash the entire Pokémon catalogue.
 *
 * So: for a new game, a base card and its alternate art may currently share
 * one row. That is a KNOWN, BOUNDED limitation, not a solved problem, and
 * it is the first thing to check when a new game's prices look wrong.
 */
function mapSimplePrintingAxis(providerVariant: string | null): MappedVariantIdentity | null {
  const v = providerVariant?.trim().toLowerCase();
  if (!v) return null;

  const edition: Edition = "na";
  const finish: Finish = "na";

  // Non-foil.
  if (v === "normal" || v === "non-foil" || v === "nonfoil" || v === "base") {
    return { edition, variant: "normal" as Variant, finish };
  }

  // Foil, under the several spellings these APIs use interchangeably.
  if (v === "foil" || v === "holofoil" || v === "holo" || v === "rare foil") {
    return { edition, variant: "holo" as Variant, finish };
  }

  // Promotional printings are a genuinely distinct variant in our model and
  // every one of these games has them.
  if (v === "promo" || v === "promotional") {
    return { edition, variant: "promo" as Variant, finish };
  }

  return null;
}

/**
 * Map a provider's own variant/printing string onto our identity fields,
 * using the vocabulary of the GAME the card belongs to.
 *
 * Routing on game rather than on provider name is deliberate: two providers
 * covering One Piece will use the same printing vocabulary as each other
 * long before either uses Pokémon's, and the identity we are building
 * belongs to the card, not to whoever told us about it.
 */
export function mapProviderVariant(game: Game, providerVariant: string | null): MappedVariantIdentity | null {
  switch (game) {
    case "pokemon":
      // Unchanged, and deliberately still its own function: PokeTrace's
      // six-value enum carries edition information (1st vs Unlimited) that
      // no other game's printing field does.
      return mapPokeTraceVariant(providerVariant);
    case "onepiece":
    case "magic":
    case "lorcana":
    case "yugioh":
    case "riftbound":
      return mapSimplePrintingAxis(providerVariant);
    default: {
      const exhaustiveCheck: never = game;
      throw new Error(`mapProviderVariant: no variant vocabulary for game '${String(exhaustiveCheck)}'`);
    }
  }
}
