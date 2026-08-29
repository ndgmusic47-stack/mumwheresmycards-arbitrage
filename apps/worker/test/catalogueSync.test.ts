import { describe, it, expect } from "vitest";
import { MockCatalogueProvider, CATALOGUE_CARD_FIXTURES } from "@mwmc/providers";
import type { CatalogueProvider, CataloguePage } from "@mwmc/providers";
import { runCatalogueSync } from "../src/catalogue/catalogueSync.js";
import { FakeCatalogueSyncRepo } from "./helpers/fakeCatalogueSyncRepo.js";

// 8 fixtures total; 1 is deliberately unmappable (unrecognized provider
// variant — "Mystery Promo"). "Mystery Card" has an unresolvable set year
// but is otherwise complete, so it's mappable (with year: null) — see
// packages/providers/src/fixtures/catalogue.fixtures.ts.
const EXPECTED_MAPPABLE = CATALOGUE_CARD_FIXTURES.length - 1;

describe("runCatalogueSync — empty-DB bootstrap", () => {
  it("bootstraps `cards` from a completely empty repo with no manually seeded cards", async () => {
    const provider = new MockCatalogueProvider();
    const repo = new FakeCatalogueSyncRepo();

    const result = await runCatalogueSync(provider, repo, { pageSize: 2, maxPagesPerRun: 25 });

    expect(result.status).toBe("SUCCESS");
    expect(repo.cards.size).toBe(EXPECTED_MAPPABLE);
    expect(result.cardsInserted).toBe(EXPECTED_MAPPABLE);
    expect(result.cardsUpdated).toBe(0);
    expect(result.reachedEnd).toBe(true);
  });

  it("skips a card with an unrecognized provider variant rather than guessing an identity", async () => {
    const provider = new MockCatalogueProvider();
    const repo = new FakeCatalogueSyncRepo();
    const result = await runCatalogueSync(provider, repo, { pageSize: 8 });

    expect(result.cardsSkipped).toBeGreaterThanOrEqual(1);
    const names = [...repo.cards.values()].map((c) => c.name);
    expect(names).not.toContain("Mystery Promo");
  });

  it("still catalogues a card whose set cannot be resolved to a year, storing year: null rather than fabricating one", async () => {
    const provider = new MockCatalogueProvider();
    const repo = new FakeCatalogueSyncRepo();
    await runCatalogueSync(provider, repo, { pageSize: 8 });

    const mysteryCard = [...repo.cards.values()].find((c) => c.name === "Mystery Card");
    expect(mysteryCard).toBeDefined();
    expect(mysteryCard!.year).toBeNull();
  });
});

describe("runCatalogueSync — pagination", () => {
  it("fetches multiple pages when the fixture set exceeds one page", async () => {
    const provider = new MockCatalogueProvider();
    const repo = new FakeCatalogueSyncRepo();
    const result = await runCatalogueSync(provider, repo, { pageSize: 2 });

    expect(result.pagesFetched).toBeGreaterThan(1);
    expect(result.pagesFetched).toBe(Math.ceil(CATALOGUE_CARD_FIXTURES.length / 2));
  });

  it("respects maxPagesPerRun, leaving the sync unfinished for a later run to continue", async () => {
    const provider = new MockCatalogueProvider();
    const repo = new FakeCatalogueSyncRepo();
    const result = await runCatalogueSync(provider, repo, { pageSize: 2, maxPagesPerRun: 1 });

    expect(result.pagesFetched).toBe(1);
    expect(result.reachedEnd).toBe(false);
    expect(repo.cards.size).toBeLessThan(EXPECTED_MAPPABLE);
  });
});

describe("runCatalogueSync — external ID mapping", () => {
  it("records a provider -> internal card id mapping for every synced card", async () => {
    const provider = new MockCatalogueProvider();
    const repo = new FakeCatalogueSyncRepo();
    await runCatalogueSync(provider, repo, { pageSize: 8 });

    expect(repo.externalRefs.length).toBe(EXPECTED_MAPPABLE);
    const charizardRef = repo.externalRefs.find((r) => r.providerCardId === "pt_charizard_bs_4_102_1st_holo");
    expect(charizardRef).toBeDefined();
    expect(charizardRef!.provider).toBe("mock");
    expect(repo.cards.has(charizardRef!.internalCardId)).toBe(true);
  });
});

describe("runCatalogueSync — resume after failure", () => {
  it("resumes from the last successfully-saved checkpoint after a mid-run failure", async () => {
    const repo = new FakeCatalogueSyncRepo();
    const realProvider = new MockCatalogueProvider();

    let callCount = 0;
    const flakyProvider: CatalogueProvider = {
      name: realProvider.name,
      fetchSets: () => realProvider.fetchSets(),
      fetchPage: async (cursor: string | null, limit?: number): Promise<CataloguePage> => {
        callCount++;
        if (callCount === 2) throw new Error("simulated network failure on page 2");
        return realProvider.fetchPage(cursor, limit);
      },
    };

    const firstRun = await runCatalogueSync(flakyProvider, repo, { pageSize: 2 });
    expect(firstRun.status).toBe("FAILED");
    // Page 1 succeeded and was checkpointed before page 2 threw.
    expect(repo.cards.size).toBe(2);
    const checkpointAfterFailure = await repo.getCheckpoint("mock");
    expect(checkpointAfterFailure?.cursor).toBe("2");

    // A second run, now against the healthy provider, resumes from that
    // checkpoint rather than restarting from the top.
    const secondRun = await runCatalogueSync(realProvider, repo, { pageSize: 2 });
    expect(secondRun.cursorStart).toBe("2");
    expect(secondRun.status).toBe("SUCCESS");
    expect(repo.cards.size).toBe(EXPECTED_MAPPABLE);
  });
});
