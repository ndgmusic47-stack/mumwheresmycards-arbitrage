import { Hono } from "hono";
import { Db } from "@mwmc/db";
import { summarizeForecastVariance } from "@mwmc/core";
import { createAiModelProvider, AiCompletionCache, GuardedAiModelProvider, AiFinancialAuditorProvider } from "@mwmc/providers";
import { loadReconciliationRecords, type ReconciliationRecord } from "../repo/reconciliationRepo.js";
import { loadSettings } from "../repo/settingsRepo.js";
import type { Env } from "../env.js";

export const reconciliationRoute = new Hono<{ Bindings: Env }>();

/**
 * AI INTELLIGENCE spec Phase 2, Workstream N: `GET
 * /trade/api/reconciliation` — the realised-vs-predicted view across
 * every completed (sold) trade, plus (opt-in) an AI financial auditor's
 * narrative over the aggregate pattern. Loads every reconciled trade
 * (`loadReconciliationRecords`, `../repo/reconciliationRepo.js`), computes
 * overall/FLIP/GRADE `VarianceSummary` statistics
 * (`summarizeForecastVariance`, `@mwmc/core`), and — only when `?audit=1`
 * is passed AND there is at least one trade with a forecast to compare
 * against — asks the AI financial auditor (AUDIT tier, same provider-chain
 * composition as every other AI route since Workstream J) to narrate the
 * pattern. Audit narration is opt-in for the same reason Workstream M's
 * scenario narration is: it costs real money, and this endpoint's own
 * default (no query param) should stay a free, always-safe deterministic
 * view.
 */
reconciliationRoute.get("/", async (c) => {
  const db = new Db(c.env.DB);
  const wantsAudit = c.req.query("audit") === "1" || c.req.query("audit") === "true";

  const records = await loadReconciliationRecords(db);

  const overallSummary = summarizeForecastVariance(records.map((r) => r.forecastVsRealised));
  const flipSummary = summarizeForecastVariance(
    records.filter((r) => r.strategy === "FLIP").map((r) => r.forecastVsRealised),
  );
  const gradeSummary = summarizeForecastVariance(
    records.filter((r) => r.strategy === "GRADE").map((r) => r.forecastVsRealised),
  );

  let audit: { available: boolean; summary: string | null; caveats: string[] } | null = null;
  let providerName: string | null = null;

  if (wantsAudit) {
    if (overallSummary.sampleSize === 0) {
      // No trade with a forecast to compare against yet — never send an
      // empty/fabricated aggregate to the model, same "skip narration,
      // give an honest reason" discipline as Workstream M's no-PSA10-data
      // guard.
      audit = {
        available: false,
        summary: null,
        caveats: ["No realised trades with a forecast to compare against yet — nothing to audit."],
      };
    } else {
      const settings = await loadSettings(db);
      const modelProvider = createAiModelProvider(c.env);
      const cached = new AiCompletionCache(db, modelProvider, {
        dailySpendCapUsd: settings.ai.dailySpendCapUsd,
        pricing: settings.ai.pricingUsdPerMTok,
        scanRunId: null,
      });
      const guarded = new GuardedAiModelProvider(cached);
      const auditor = new AiFinancialAuditorProvider(guarded);

      audit = await auditor.auditPerformance({
        sampleSize: overallSummary.sampleSize,
        overallSummary,
        flipSummary: flipSummary.sampleSize > 0 ? flipSummary : undefined,
        gradeSummary: gradeSummary.sampleSize > 0 ? gradeSummary : undefined,
      });
      providerName = auditor.name;
    }
  }

  return c.json({
    records: records.map(toApiRecord),
    summary: { overall: overallSummary, flip: flipSummary, grade: gradeSummary },
    audit,
    providerName,
  });
});

function toApiRecord(record: ReconciliationRecord) {
  return {
    inventoryId: record.inventoryId,
    cardId: record.cardId,
    cardName: record.cardName,
    strategy: record.strategy,
    soldAt: record.soldAt,
    hasForecast: record.hasForecast,
    actualGrade: record.actualGrade,
    ...record.forecastVsRealised,
  };
}
