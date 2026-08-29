import type { CardPrinting } from "@mwmc/core";
import type { CatalogueSyncRepo } from "../../src/catalogue/catalogueSync.js";

/**
 * In-memory CatalogueSyncRepo — lets catalogueSync.test.ts exercise the
 * resumable sync ALGORITHM (bootstrap, pagination, resume-after-failure,
 * external ID mapping) without Miniflare/D1. The real D1-backed
 * implementation is apps/worker/src/repo/catalogueSyncRepo.ts.
 */
export class FakeCatalogueSyncRepo implements CatalogueSyncRepo {
  checkpoints = new Map<string, string | null>();
  cards = new Map<string, CardPrinting>(); // keyed by printingHash
  externalRefs: { provider: string; providerCardId: string; internalCardId: string; providerUpdatedAt: string | null }[] = [];

  async getCheckpoint(providerName: string): Promise<{ cursor: string | null } | null> {
    if (!this.checkpoints.has(providerName)) return null;
    return { cursor: this.checkpoints.get(providerName) ?? null };
  }

  async saveCheckpoint(providerName: string, cursor: string | null): Promise<void> {
    this.checkpoints.set(providerName, cursor);
  }

  async upsertCard(printing: CardPrinting): Promise<"inserted" | "updated"> {
    const existed = this.cards.has(printing.printingHash);
    this.cards.set(printing.printingHash, printing);
    return existed ? "updated" : "inserted";
  }

  async upsertExternalRef(
    providerName: string,
    providerCardId: string,
    internalCardId: string,
    providerUpdatedAt: string | null,
  ): Promise<void> {
    const existing = this.externalRefs.find((r) => r.provider === providerName && r.providerCardId === providerCardId);
    if (existing) {
      existing.internalCardId = internalCardId;
      existing.providerUpdatedAt = providerUpdatedAt;
    } else {
      this.externalRefs.push({ provider: providerName, providerCardId, internalCardId, providerUpdatedAt });
    }
  }
}
