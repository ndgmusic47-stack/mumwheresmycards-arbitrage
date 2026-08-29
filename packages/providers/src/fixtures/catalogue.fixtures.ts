import type { CatalogueCardDTO, CatalogueSetInfo } from "../catalogue/CatalogueProvider.js";

/**
 * Mock catalogue fixtures. Three entries deliberately share a
 * `providerCardId` with packages/providers/src/fixtures/market.fixtures.ts
 * (Charizard/Umbreon/Mewtwo) so a mock end-to-end flow — catalogue sync ->
 * external_card_refs -> market lookup -> market profile -> dynamic
 * universe — has real data to work with. The rest exist purely to give
 * pagination/resume tests more than one page to work through.
 */
export const CATALOGUE_SET_FIXTURES: CatalogueSetInfo[] = [
  { setCode: "base-set", setName: "Base Set", year: 1999 },
  { setCode: "evolving-skies", setName: "Evolving Skies", year: 2021 },
  { setCode: "jungle", setName: "Jungle", year: 1999 },
  { setCode: "fossil", setName: "Fossil", year: 1999 },
  { setCode: "sword-shield-promo", setName: "SWSH Black Star Promos", year: 2020 },
];

export const CATALOGUE_CARD_FIXTURES: CatalogueCardDTO[] = [
  {
    providerCardId: "pt_charizard_bs_4_102_1st_holo",
    name: "Charizard",
    setName: "Base Set",
    setCode: "base-set",
    cardNumber: "4/102",
    providerVariant: "1st_Edition_Holofoil",
    rarity: "Rare Holo",
    game: "pokemon",
    market: "US",
    image: null,
    providerUpdatedAt: "2026-08-20T00:00:00.000Z",
  },
  {
    providerCardId: "pt_umbreon_vmax_evs_215_203_holo",
    name: "Umbreon VMAX",
    setName: "Evolving Skies",
    setCode: "evolving-skies",
    cardNumber: "215/203",
    providerVariant: "Holofoil",
    rarity: "Secret Rare",
    game: "pokemon",
    market: "US",
    image: null,
    providerUpdatedAt: "2026-08-27T00:00:00.000Z",
  },
  {
    providerCardId: "pt_mewtwo_bs_10_102_unl_holo",
    name: "Mewtwo",
    setName: "Base Set",
    setCode: "base-set",
    cardNumber: "10/102",
    providerVariant: "Unlimited",
    rarity: "Rare Holo",
    game: "pokemon",
    market: "US",
    image: null,
    providerUpdatedAt: "2026-08-10T00:00:00.000Z",
  },
  {
    providerCardId: "pt_blastoise_bs_2_102_unl_holo",
    name: "Blastoise",
    setName: "Base Set",
    setCode: "base-set",
    cardNumber: "2/102",
    providerVariant: "Unlimited",
    rarity: "Rare Holo",
    game: "pokemon",
    market: "US",
    image: null,
    providerUpdatedAt: "2026-08-05T00:00:00.000Z",
  },
  {
    providerCardId: "pt_pikachu_jungle_60_64",
    name: "Pikachu",
    setName: "Jungle",
    setCode: "jungle",
    cardNumber: "60/64",
    providerVariant: "Normal",
    rarity: "Common",
    game: "pokemon",
    market: "US",
    image: null,
    providerUpdatedAt: "2026-07-15T00:00:00.000Z",
  },
  {
    providerCardId: "pt_articuno_fossil_2_62_holo",
    name: "Articuno",
    setName: "Fossil",
    setCode: "fossil",
    cardNumber: "2/62",
    providerVariant: "Holofoil",
    rarity: "Rare Holo",
    game: "pokemon",
    market: "EU",
    image: null,
    providerUpdatedAt: "2026-07-01T00:00:00.000Z",
  },
  {
    // Unmappable/unknown provider variant on purpose — exercises the sync
    // engine's "skip rather than guess" path for an unrecognized enum value.
    providerCardId: "pt_unknown_variant_card",
    name: "Mystery Promo",
    setName: "SWSH Black Star Promos",
    setCode: "sword-shield-promo",
    cardNumber: "SWSH999",
    providerVariant: "Textured_Foil_Special",
    rarity: "Promo",
    game: "pokemon",
    market: "US",
    image: null,
    providerUpdatedAt: "2026-06-01T00:00:00.000Z",
  },
  {
    // Set year unresolvable on purpose (setCode isn't in
    // CATALOGUE_SET_FIXTURES) — otherwise complete, so it exercises the
    // sync engine's "store year: null rather than fabricate one, and don't
    // skip the card" path. setName is a real (non-null) value here
    // deliberately, so this fixture tests ONLY the year gap — see
    // "Mystery Promo" above for the separate unmappable-variant skip case.
    providerCardId: "pt_unknown_set_card",
    name: "Mystery Card",
    setName: "Unlisted Promo Set",
    setCode: "totally-unknown-set",
    cardNumber: "1/1",
    providerVariant: "Normal",
    rarity: "Common",
    game: "pokemon",
    market: "US",
    image: null,
    providerUpdatedAt: "2026-06-01T00:00:00.000Z",
  },
];
