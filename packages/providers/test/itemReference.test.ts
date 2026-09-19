import { describe, it, expect } from "vitest";
import { parseEbayItemReference } from "../src/ebay/itemReference.js";

/**
 * The real listing this was built against, from the production database:
 *
 *   https://www.ebay.co.uk/itm/800656995404?_skw=Pikachu+EX+-+XY124+XY+Promos+XY124&hash=itemba6ae0344c:g:QkgAAeSwzmBqpwRp
 *   item id v1|800656995404|0
 *
 * Note the `hash=itemba6ae0344c` — one of several long tokens in a real eBay
 * URL that are not the item number. Grabbing the first long number found is
 * the obvious implementation and the wrong one.
 */
describe("what the operator actually pastes", () => {
  it("reads the item number out of a full eBay URL with tracking junk on it", () => {
    const parsed = parseEbayItemReference(
      "https://www.ebay.co.uk/itm/800656995404?_skw=Pikachu+EX+-+XY124+XY+Promos+XY124&hash=itemba6ae0344c:g:QkgAAeSwzmBqpwRp",
    );
    expect(parsed).toEqual({ restfulItemId: "v1|800656995404|0", legacyItemId: "800656995404" });
  });

  it("handles the slug form, where the number is the last path segment", () => {
    expect(parseEbayItemReference("https://www.ebay.com/itm/Charizard-Base-Set-Holo/800656995404")?.legacyItemId).toBe(
      "800656995404",
    );
  });

  it("handles a link pasted without the protocol", () => {
    expect(parseEbayItemReference("ebay.co.uk/itm/800656995404")?.legacyItemId).toBe("800656995404");
  });

  it("handles the bare item number", () => {
    expect(parseEbayItemReference("800656995404")).toEqual({
      restfulItemId: "v1|800656995404|0",
      legacyItemId: "800656995404",
    });
  });

  it("handles the older ?item= query form", () => {
    expect(parseEbayItemReference("https://www.ebay.co.uk/ws/eBayISAPI.dll?ViewItem&item=800656995404")?.legacyItemId).toBe(
      "800656995404",
    );
  });

  it("trims whatever whitespace came with the paste", () => {
    expect(parseEbayItemReference("  800656995404\n")?.legacyItemId).toBe("800656995404");
  });
});

describe("an id that is already RESTful", () => {
  it("passes it through untouched", () => {
    expect(parseEbayItemReference("v1|800656995404|0")).toEqual({
      restfulItemId: "v1|800656995404|0",
      legacyItemId: "800656995404",
    });
  });

  /**
   * A non-zero suffix addresses one VARIATION of a multi-variation listing.
   * Rebuilding it as |0 would silently fetch a different variation — a
   * different card, at a different price, added to the pipeline under the
   * operator's nose.
   */
  it("keeps a variation suffix rather than normalising it away", () => {
    expect(parseEbayItemReference("v1|800656995404|123456")?.restfulItemId).toBe("v1|800656995404|123456");
  });
});

describe("what it refuses, rather than guessing at", () => {
  it("does not mistake a tracking token for the item", () => {
    // No /itm/ segment and no item= param: there is no item number here,
    // only numbers.
    expect(parseEbayItemReference("https://www.ebay.co.uk/sch/i.html?_nkw=charizard&_trkparms=9876543210123")).toBeNull();
  });

  it("refuses a non-eBay URL", () => {
    expect(parseEbayItemReference("https://www.tcgplayer.com/product/123436")).toBeNull();
  });

  it("refuses a number too short or too long to be an item id", () => {
    expect(parseEbayItemReference("12345")).toBeNull();
    expect(parseEbayItemReference("1234567890123456789")).toBeNull();
  });

  it("refuses nothing at all", () => {
    expect(parseEbayItemReference("")).toBeNull();
    expect(parseEbayItemReference("   ")).toBeNull();
    expect(parseEbayItemReference(null)).toBeNull();
    expect(parseEbayItemReference(undefined)).toBeNull();
  });

  it("refuses free text", () => {
    expect(parseEbayItemReference("the pikachu one from that seller")).toBeNull();
  });
});
