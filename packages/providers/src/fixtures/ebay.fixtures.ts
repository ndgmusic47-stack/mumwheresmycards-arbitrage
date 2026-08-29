import type { RawEbayListing } from "../ebay/EbayListingsProvider.js";

/**
 * Canned active-listing fixtures for local dev / opportunity-engine tests.
 * Mirrors (by identity) the cards in market.fixtures.ts so the two mocked
 * providers combine into realistic end-to-end scenarios without any
 * network access:
 *
 *  - "Charizard 1st ed shadowless holo" listings: one underpriced-for-grading
 *    bargain, one fairly priced.
 *  - "Umbreon VMAX" listings: a clean high-confidence flip and a razor-thin
 *    non-flip.
 *  - "Mewtwo unlimited" listing: low liquidity — expected to be filtered.
 *  - one listing with a deliberately ambiguous/incomplete title so the
 *    resolver flags it REJECTED — CARD IDENTITY UNCERTAIN.
 */
export const EBAY_LISTING_FIXTURES: RawEbayListing[] = [
  {
    ebayItemId: "ebay-fixture-001",
    title: "1999 Pokemon Base Set Charizard 4/102 Holo 1st Edition Shadowless PSA-ready",
    price: 1850,
    currency: "GBP",
    shippingCost: 12,
    listingType: "FIXED",
    itemCondition: "Ungraded",
    sellerUsername: "vintage_card_vault",
    sellerFeedbackScore: 4820,
    sellerFeedbackPct: 99.6,
    itemUrl: "https://www.ebay.co.uk/itm/ebay-fixture-001",
    imageUrls: ["https://images.example.com/fixture-001-front.jpg", "https://images.example.com/fixture-001-back.jpg"],
    locationCountry: "GB",
    watchers: 34,
    bids: undefined,
    endTime: null,
    parsedIdentity: {
      game: "pokemon",
      name: "Charizard",
      setName: "Base Set",
      setCode: "BS",
      cardNumber: "4/102",
      year: 1999,
      language: "EN",
      edition: "1st",
      variant: "holo",
      finish: "shadowless",
      rarity: "Holo Rare",
    },
  },
  {
    ebayItemId: "ebay-fixture-002",
    title: "Pokemon Base Set Charizard Holo 1st Edition Shadowless - light play",
    price: 3050, // near market value — thin/no margin
    currency: "GBP",
    shippingCost: 15,
    listingType: "FIXED",
    itemCondition: "Played",
    sellerUsername: "cardking99",
    sellerFeedbackScore: 210,
    sellerFeedbackPct: 97.1,
    itemUrl: "https://www.ebay.co.uk/itm/ebay-fixture-002",
    imageUrls: ["https://images.example.com/fixture-002-front.jpg"],
    locationCountry: "GB",
    watchers: 5,
    endTime: null,
    parsedIdentity: {
      game: "pokemon",
      name: "Charizard",
      setName: "Base Set",
      setCode: "BS",
      cardNumber: "4/102",
      year: 1999,
      language: "EN",
      edition: "1st",
      variant: "holo",
      finish: "shadowless",
      rarity: "Holo Rare",
    },
  },
  {
    ebayItemId: "ebay-fixture-003",
    title: "Umbreon VMAX Evolving Skies 215/203 Alt Art Secret Rare NM",
    price: 150, // well under the ~185-210 QSV/market range
    currency: "GBP",
    shippingCost: 3.5,
    listingType: "FIXED",
    itemCondition: "Near Mint",
    sellerUsername: "modern_singles_uk",
    sellerFeedbackScore: 9120,
    sellerFeedbackPct: 99.9,
    itemUrl: "https://www.ebay.co.uk/itm/ebay-fixture-003",
    imageUrls: ["https://images.example.com/fixture-003-front.jpg", "https://images.example.com/fixture-003-back.jpg"],
    locationCountry: "GB",
    watchers: 61,
    endTime: null,
    parsedIdentity: {
      game: "pokemon",
      name: "Umbreon VMAX",
      setName: "Evolving Skies",
      setCode: "EVS",
      cardNumber: "215/203",
      year: 2021,
      language: "EN",
      edition: "na",
      variant: "holo",
      finish: "na",
      rarity: "Secret Rare",
    },
  },
  {
    ebayItemId: "ebay-fixture-004",
    title: "Umbreon VMAX Alt Art 215/203 - price firm",
    price: 205, // basically at market — should not clear default margin filters
    currency: "GBP",
    shippingCost: 4,
    listingType: "FIXED",
    itemCondition: "Near Mint",
    sellerUsername: "modern_singles_uk",
    sellerFeedbackScore: 9120,
    sellerFeedbackPct: 99.9,
    itemUrl: "https://www.ebay.co.uk/itm/ebay-fixture-004",
    imageUrls: ["https://images.example.com/fixture-004-front.jpg"],
    locationCountry: "GB",
    watchers: 12,
    endTime: null,
    parsedIdentity: {
      game: "pokemon",
      name: "Umbreon VMAX",
      setName: "Evolving Skies",
      setCode: "EVS",
      cardNumber: "215/203",
      year: 2021,
      language: "EN",
      edition: "na",
      variant: "holo",
      finish: "na",
      rarity: "Secret Rare",
    },
  },
  {
    ebayItemId: "ebay-fixture-005",
    title: "Pokemon Mewtwo Base Set Holo unlimited played",
    price: 45,
    currency: "GBP",
    shippingCost: 3,
    listingType: "FIXED",
    itemCondition: "Played",
    sellerUsername: "loose_change_cards",
    sellerFeedbackScore: 34,
    sellerFeedbackPct: 92.0,
    itemUrl: "https://www.ebay.co.uk/itm/ebay-fixture-005",
    imageUrls: ["https://images.example.com/fixture-005-front.jpg"],
    locationCountry: "GB",
    watchers: 1,
    endTime: null,
    parsedIdentity: {
      game: "pokemon",
      name: "Mewtwo",
      setName: "Base Set",
      setCode: "BS",
      cardNumber: "10/102",
      year: 1999,
      language: "EN",
      edition: "unlimited",
      variant: "holo",
      finish: "unlimited_shadow",
      rarity: "Holo Rare",
    },
  },
  {
    ebayItemId: "ebay-fixture-006",
    title: "Vintage holo Pokemon card RARE bundle look!!",
    price: 89,
    currency: "GBP",
    shippingCost: 4,
    listingType: "AUCTION",
    itemCondition: "Unknown",
    sellerUsername: "attic_finds_2024",
    sellerFeedbackScore: 8,
    sellerFeedbackPct: 80.0,
    itemUrl: "https://www.ebay.co.uk/itm/ebay-fixture-006",
    imageUrls: ["https://images.example.com/fixture-006-front.jpg"],
    locationCountry: "GB",
    watchers: 2,
    bids: 1,
    endTime: "2026-09-01T18:00:00.000Z",
    // Deliberately incomplete — title doesn't disambiguate set/number/edition/variant.
    // Exercises REJECTED — CARD IDENTITY UNCERTAIN in the opportunity engine.
    parsedIdentity: {
      name: "Unknown",
    },
  },
];

export function findEbayFixturesByKeyword(keywords: string): RawEbayListing[] {
  const needle = keywords.toLowerCase();
  const terms = needle.split(/\s+/).filter(Boolean);
  return EBAY_LISTING_FIXTURES.filter((listing) => {
    const haystack = listing.title.toLowerCase();
    return terms.every((term) => haystack.includes(term));
  });
}
