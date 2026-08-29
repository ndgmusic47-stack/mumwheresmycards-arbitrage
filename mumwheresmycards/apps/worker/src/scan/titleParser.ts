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
 * name/setName/setCode/cardNumber/year/rarity/game are passed through
 * unchanged: those are what defined the search query in the first place,
 * so verifying them from title text adds little and risks false negatives
 * from inconsistent title formatting.
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

  return result;
}
