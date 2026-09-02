import type { RawCardIdentity } from "@mwmc/core";

/**
 * Reconciles a "search target" identity (the exact printing we searched
 * eBay for) against what the listing TITLE actually corroborates, for the
 * variant-sensitive fields that are easy to mis-list or mis-search
 * (edition, finish, variant, language). This is a deliberately
 * conservative safety net, not a title -> identity parser: a search for
 * "Charizard Base Set 1st Edition Shadowless Holo" can still return a
 * listing for the Unlimited print (bad SEO titles, mis-categorization), so
 * we only KEEP a field when the title corroborates it and DROP it
 * (never guess/keep-anyway) when the title doesn't — dropping a required
 * field routes the listing to REJECTED — CARD IDENTITY UNCERTAIN via the
 * canonical card resolver, which is the safe outcome.
 *
 * STABILISATION item 5 (identity safety): `name` and `cardNumber` are ALSO
 * now checked against the title — previously (like every field below) they
 * were passed through from the search target completely unverified, which
 * meant eBay returning a listing for a genuinely different card (bad
 * SEO/keyword-stuffed titles, mis-categorized listings — eBay's search is
 * full-text, not exact-match) had nothing to catch it before it flowed all
 * the way into a forecasted trade. These two are checked, not the other
 * required fields, because they're the two failure modes that actually
 * matter (wrong Pokémon entirely; wrong specific printing within a set) AND
 * the two a real listing title reliably states: `name` is dropped only when
 * the title never mentions the card at all (virtually every genuine listing
 * names the card — a true absence is a strong signal, not noise), and
 * `cardNumber` is dropped only on an explicit CONTRADICTION (title shows a
 * different "N/M" number outright) — never for merely omitting it, since
 * plenty of genuine listings don't print the number. Both reuse the
 * existing "corroborate-or-drop, never guess" contract below.
 *
 * setName/setCode/year/rarity/game are still passed through unchanged: set
 * names and codes are routinely abbreviated, reformatted or omitted
 * entirely in real listing titles (no reliable low-false-negative way to
 * check them from free text alone), so requiring a match there would drop
 * large numbers of genuinely correct listings rather than catching bad
 * ones — those three fields were what defined the search query in the
 * first place, and name+cardNumber corroboration above already catches the
 * cases that matter most.
 */
export function reconcileIdentityWithTitle(target: RawCardIdentity, title: string): RawCardIdentity {
  const t = title.toLowerCase();
  const result: RawCardIdentity = { ...target };

  if (target.edition === "1st") {
    if (!/1st\s*ed(ition)?/i.test(t)) result.edition = undefined;
  } else if (target.edition === "unlimited") {
    if (/1st\s*ed(ition)?/i.test(t)) result.edition = undefined; // contradicts — don't assume
  }

  if (target.finish === "shadowless") {
    if (!/shadowless/i.test(t)) result.finish = undefined;
  } else if (target.finish === "unlimited_shadow") {
    if (/shadowless/i.test(t)) result.finish = undefined; // contradicts
  }

  if (target.variant === "holo") {
    if (/reverse/i.test(t)) result.variant = undefined; // likely actually reverse holo
  } else if (target.variant === "reverse_holo") {
    if (!/reverse/i.test(t)) result.variant = undefined;
  } else if (target.variant === "stamped") {
    if (!/stamp/i.test(t)) result.variant = undefined;
  }

  if (target.language && target.language !== "EN") {
    const languageHints: Record<string, RegExp> = {
      JA: /japan(ese)?/i,
      FR: /fran[cç]ais|french/i,
      DE: /deutsch|german/i,
      IT: /italian/i,
      ES: /spanish|espa[nñ]ol/i,
      KO: /korean/i,
      ZH: /chinese/i,
    };
    const hint = languageHints[target.language];
    if (hint && !hint.test(t)) result.language = undefined;
  } else if (target.language === "EN") {
    // Non-EN mentions on an EN search target are a red flag — drop rather than assume EN.
    if (/japan(ese)?|korean|chinese|deutsch|german|fran[cç]ais|french|italian|spanish/i.test(t)) {
      result.language = undefined;
    }
  }

  // name: drop only on true absence — the card's name never appears
  // anywhere in the title, in any spacing/punctuation. Compared as a
  // stripped-to-alphanumeric substring so "Pikachu VMAX" still matches a
  // title spelling it "Pikachu V MAX" or "Pikachu-VMAX".
  if (target.name && !stripToAlnum(t).includes(stripToAlnum(target.name))) {
    result.name = undefined;
  }

  // cardNumber: drop only on an explicit contradiction — the title states
  // an "N/M" card number and it's a DIFFERENT one from the target's. A
  // title that omits the number entirely is not a contradiction and is
  // left alone (target.cardNumber is kept).
  if (target.cardNumber?.includes("/")) {
    const targetNormalized = target.cardNumber.replace(/\s+/g, "");
    const titleNumberMatch = t.match(/\b\d+\s*\/\s*\d+\b/);
    if (titleNumberMatch && titleNumberMatch[0].replace(/\s+/g, "") !== targetNormalized) {
      result.cardNumber = undefined;
    }
  }

  return result;
}

/** Lowercases and strips everything but letters/digits, so spacing and
 *  punctuation differences between a card name and a listing title never
 *  cause a spurious mismatch (see the `name` check above). */
function stripToAlnum(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}
