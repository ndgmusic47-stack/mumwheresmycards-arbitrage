/**
 * TURNING WHATEVER THE OPERATOR PASTED INTO AN EBAY ITEM ID.
 *
 * Added 2026-09-14 for "add a lead by hand": a card bought from a seller the
 * scanner never surfaced still has to be trackable, and the only thing the
 * operator reliably has to hand is the browser URL.
 *
 * The Browse API addresses items as `v1|<legacy id>|0` (RESTful Item ID),
 * while every link a human copies carries the plain legacy number, dressed
 * differently depending on where it came from:
 *
 *   https://www.ebay.co.uk/itm/800656995404?_skw=Pikachu+EX...
 *   https://www.ebay.com/itm/Charizard-Base-Set/800656995404
 *   ebay.co.uk/itm/800656995404
 *   800656995404
 *   v1|800656995404|0
 *
 * WHY NOT JUST GRAB THE FIRST LONG NUMBER. eBay URLs are full of long
 * numbers that are not the item — `_trkparms`, campaign ids, `hash=item...`,
 * epids. Taking the first match found would fetch the wrong listing and,
 * worse, do it silently. So the item number is only read from the places it
 * genuinely lives: the `/itm/` path segment, an `item=` query parameter, or
 * the whole string when the operator pasted just the number.
 *
 * Returning null rather than a guess is the point. An unrecognised reference
 * has to come back to the operator as "that doesn't look like an item link",
 * because the alternative is quietly adding a different card to his pipeline.
 */

/** eBay legacy item numbers are 9-15 digits. */
const LEGACY_ID = /^\d{9,15}$/;

export interface ParsedItemReference {
  /** The RESTful id to call the Browse API with, e.g. "v1|800656995404|0". */
  restfulItemId: string;
  /** The plain number, as it appears in a URL. */
  legacyItemId: string;
}

export function parseEbayItemReference(reference: string | null | undefined): ParsedItemReference | null {
  if (typeof reference !== "string") return null;
  const trimmed = reference.trim();
  if (trimmed === "") return null;

  // Already a RESTful id. Accept it whole rather than reassembling it, so a
  // non-zero variation suffix (v1|123|456789) survives — those address a
  // specific variation of a multi-variation listing and dropping the suffix
  // would silently fetch the wrong one.
  const restful = trimmed.match(/^v1\|(\d{9,15})\|(\d+)$/);
  if (restful) return { restfulItemId: trimmed, legacyItemId: restful[1]! };

  // Bare number.
  if (LEGACY_ID.test(trimmed)) return fromLegacy(trimmed);

  let url: URL | null = null;
  try {
    url = new URL(trimmed.includes("://") ? trimmed : `https://${trimmed}`);
  } catch {
    return null;
  }
  if (!/(^|\.)ebay\./i.test(url.hostname)) return null;

  // /itm/<id> or /itm/<slug>/<id>
  const segments = url.pathname.split("/").filter(Boolean);
  const itmIndex = segments.findIndex((s) => s.toLowerCase() === "itm");
  if (itmIndex !== -1) {
    for (const segment of segments.slice(itmIndex + 1)) {
      if (LEGACY_ID.test(segment)) return fromLegacy(segment);
    }
  }

  // ?item=<id>, the older query form.
  const itemParam = url.searchParams.get("item");
  if (itemParam && LEGACY_ID.test(itemParam.trim())) return fromLegacy(itemParam.trim());

  return null;
}

function fromLegacy(legacyItemId: string): ParsedItemReference {
  return { restfulItemId: `v1|${legacyItemId}|0`, legacyItemId };
}
