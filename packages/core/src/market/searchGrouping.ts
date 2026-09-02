export interface KeyedSearchTarget {
  cardId: string;
  keywords: string;
}

export interface SearchGroup {
  keywords: string;
  cardIds: string[];
}

/**
 * STABILISATION item 11 ("avoid duplicate eBay calls/listings"): the eBay
 * search keyword string is built from name + set name + card number alone
 * (deliberately excluding edition/finish/variant/language, which real
 * listing titles are too unreliable to search on directly — see
 * titleParser.ts). That means two DIFFERENT eligible printings — say, the
 * 1st Edition and Unlimited prints of the same card, or the holo and
 * reverse-holo variants — routinely share an IDENTICAL search string. A
 * naive one-search-per-card loop would call eBay with the exact same query
 * twice (or more) in the same run, burning API budget on a request whose
 * results would have been identical either time.
 *
 * This groups a prioritised card list by keyword so the caller (scanRunner)
 * can make exactly ONE eBay call per distinct keyword, then reconcile that
 * single call's results against every card in the group independently —
 * each card's own identity check (reconcileIdentityWithTitle) still runs
 * separately per listing, exactly as it would have if the searches had
 * stayed separate. This is a pure regrouping of the SAME searches that
 * would otherwise have happened one-by-one, not a change to what gets
 * searched or how identity is resolved.
 *
 * Order is preserved: a group's position is where its FIRST member would
 * have appeared, so a group's priority in the eBay-call sequence still
 * reflects the highest-ranked card that needed it (rankForEbaySearch's
 * ordering is not otherwise touched by this function).
 */
export function groupCardsBySearchKeyword(targets: KeyedSearchTarget[]): SearchGroup[] {
  const groups = new Map<string, string[]>();

  for (const target of targets) {
    const existing = groups.get(target.keywords);
    if (existing) {
      existing.push(target.cardId);
    } else {
      groups.set(target.keywords, [target.cardId]);
    }
  }

  return Array.from(groups.entries()).map(([keywords, cardIds]) => ({ keywords, cardIds }));
}
