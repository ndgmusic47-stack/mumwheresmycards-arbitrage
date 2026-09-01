// Row types mirroring apps/worker/migrations/*.sql. Kept hand-written and
// in sync deliberately (no generator) since D1 migrations are the source of
// truth for shape but TypeScript needs its own literal unions for safety.

export type Strategy = "FLIP" | "GRADE";

export type Liquidity = "LOW" | "MEDIUM" | "HIGH" | "VERY_HIGH";

/** See packages/core/src/opportunity/states.ts — a state reflects ECONOMIC
 *  qualification, never a score threshold. */
export type OpportunityState =
  | "QUALIFIED_FLIP"
  | "QUALIFIED_GRADE"
  | "INSPECT_PHOTOS"
  | "WATCH"
  | "NO_MARKET_DATA"
  | "REJECTED_CARD_IDENTITY_UNCERTAIN"
  | "REJECTED_COMPUTATION_ERROR";

export interface CardRow {
  id: string;
  game: string;
  name: string;
  set_name: string;
  set_code: string;
  card_number: string;
  /** Null when the release year could not be resolved from the provider's
   *  catalogue (see packages/core CardPrinting.year doc comment) — never a
   *  fabricated value. */
  year: number | null;
  language: string;
  edition: string;
  variant: string;
  finish: string;
  rarity: string | null;
  stamp_type: string | null;
  printing_hash: string;
  notes: string | null;
  created_at: string;
  updated_at: string;
  last_ebay_scanned_at: string | null;
}

export interface ExternalCardRefRow {
  id: number;
  provider: string;
  provider_card_id: string;
  internal_card_id: string;
  provider_updated_at: string | null;
  /** 'US' | 'EU' | ... per the provider's own market dimension (PokeTrace:
   *  confirmed US/EU) — null for refs written before migration 0011 added
   *  this column, or if the provider payload didn't carry a market. Added
   *  because the SAME internal card (identity has no market dimension) can
   *  legitimately have more than one external_card_refs row from the same
   *  provider — one per market — and callers need to be able to pick
   *  deterministically rather than getting whichever row SQLite returns
   *  first. See externalCardRefsRepo.ts findExternalRefForCard. */
  market: string | null;
  raw_payload: string | null;
  created_at: string;
  updated_at: string;
}

export interface CatalogueSyncCheckpointRow {
  provider: string;
  cursor: string | null;
  last_full_sync_completed_at: string | null;
  updated_at: string;
}

export interface CatalogueSyncRunRow {
  id: string;
  provider: string;
  status: "RUNNING" | "SUCCESS" | "PARTIAL" | "FAILED";
  cursor_start: string | null;
  cursor_end: string | null;
  pages_fetched: number;
  cards_inserted: number;
  cards_updated: number;
  cards_skipped: number;
  api_calls_made: number;
  reached_end: number;
  errors: string | null;
  started_at: string;
  finished_at: string | null;
}

export interface FlipProfileRow {
  card_id: string;
  market_snapshot_id: number | null;
  raw_market_value: number | null;
  conservative_qsv: number | null;
  qsv_basis: string | null;
  is_high_confidence_qsv: number | null;
  raw_sample_size: number | null;
  liquidity: Liquidity;
  confidence: number;
  max_profitable_acquisition_price: number | null;
  eligible: number;
  flip_market_score: number | null;
  ineligible_reason: string | null;
  computed_at: string;
}

export interface GradeProfileRow {
  card_id: string;
  market_snapshot_id: number | null;
  raw_market_value: number | null;
  psa7: number | null;
  psa8: number | null;
  psa9: number | null;
  psa10: number | null;
  raw_sample_size: number | null;
  reference_graded_basis: number | null;
  reference_psa7_profit: number | null;
  reference_psa8_profit: number | null;
  reference_psa9_profit: number | null;
  reference_psa10_profit: number | null;
  break_even_grade: number | null;
  psa10_upside_multiple: number | null;
  psa10_gross_multiple: number | null;
  economic_class: string | null;
  economic_class_rationale: string | null;
  required_psa10_rate_vs_psa9: number | null;
  reference_service_id: string | null;
  estimated_capital_lock_days: number | null;
  liquidity: Liquidity;
  confidence: number;
  eligible: number;
  grade_market_score: number | null;
  ineligible_reason: string | null;
  computed_at: string;
}

export interface MarketSnapshotRow {
  id: number;
  card_id: string;
  source_provider: string;
  captured_at: string;
  price_timestamp: string;
  raw_market_price: number | null;
  /** 7-day SOLD median, stored raw for audit — see migration 0013. */
  raw_median_7d: number | null;
  /** 30-day SOLD median, stored raw for audit. */
  raw_median_30d: number | null;
  raw_qsv: number | null;
  /** How raw_qsv was derived — see QsvBasis in @mwmc/core. */
  qsv_basis: string | null;
  /** 1 when raw_qsv came from a sold median, 0 when from a fallback reference. */
  is_high_confidence_qsv: number | null;
  psa6: number | null;
  psa7: number | null;
  psa8: number | null;
  psa9: number | null;
  psa10: number | null;
  confidence: number;
  liquidity: Liquidity;
  sample_size: number | null;
  psa_population_7: number | null;
  psa_population_8: number | null;
  psa_population_9: number | null;
  psa_population_10: number | null;
  historical_gem_rate: number | null;
  outliers_excluded: number;
  raw_payload: string | null;
  created_at: string;
}

export interface EbayListingRow {
  id: string;
  card_id: string | null;
  identity_confidence: number;
  identity_notes: string | null;
  title: string;
  price: number;
  currency: string;
  shipping_cost: number;
  listing_type: "FIXED" | "AUCTION" | "BEST_OFFER";
  item_condition: string | null;
  // seller_username was removed in migration 0014 — the app never used it
  // for anything beyond an on-screen label, and eBay treats it as
  // account-linked data subject to their Marketplace Account Deletion /
  // Account Closure Notification requirement. Not stored, not selected.
  seller_feedback_score: number | null;
  seller_feedback_pct: number | null;
  item_url: string;
  image_urls: string | null;
  location_country: string | null;
  watchers: number | null;
  bids: number | null;
  end_time: string | null;
  fetched_at: string;
  status: "ACTIVE" | "ENDED" | "SOLD" | "REMOVED";
  raw_payload: string | null;
  created_at: string;
  updated_at: string;
}

export interface ScanRunRow {
  id: string;
  trigger: "CRON" | "MANUAL";
  started_at: string;
  finished_at: string | null;
  status: "RUNNING" | "SUCCESS" | "FAILED" | "PARTIAL";
  strategy_scope: string;
  listings_fetched: number;
  market_snapshots_fetched: number;
  opportunities_created: number;
  opportunities_updated: number;
  api_calls_made: number;
  errors: string | null;
  created_at: string;
}

export interface OpportunityRow {
  id: string;
  card_id: string;
  listing_id: string;
  market_snapshot_id: number | null;
  scan_run_id: string | null;
  strategy: Strategy;
  state: OpportunityState;
  /** 0-100 RANKING score. Never a qualification gate. */
  score: number | null;
  /** 1 when this cleared the economic bar (see @mwmc/core filters). */
  qualifies: number;
  qualification_failures: string | null;
  identity_confidence: number | null;
  flip_score: number | null;
  grade_score: number | null;
  listing_price: number;
  total_acquisition_cost: number;
  liquidity: Liquidity;
  confidence: number;
  qsv: number | null;
  qsv_basis: string | null;
  is_high_confidence_qsv: number | null;
  buyer_payment: number | null;
  selling_fees: number | null;
  expected_net_sale_proceeds: number | null;
  expected_net_profit: number | null;
  return_on_capital: number | null;
  profit_margin: number | null;
  days_to_sale_estimate: number | null;
  profit_per_capital_day: number | null;
  grader_id: string | null;
  grading_service_id: string | null;
  grading_service_name: string | null;
  total_graded_basis: number | null;
  /** JSON: the full grade ladder, all five rungs, losing ones included. */
  grade_rungs: string | null;
  psa6_profit: number | null;
  psa7_profit: number | null;
  psa8_profit: number | null;
  psa9_profit: number | null;
  psa10_profit: number | null;
  psa10_value: number | null;
  break_even_grade: string | null;
  psa10_upside_multiple: number | null;
  psa10_gross_multiple: number | null;
  economic_class: string | null;
  economic_class_rationale: string | null;
  /** REQUIRED PSA10 rate to break even — never an expected/predicted rate. */
  required_psa10_rate_vs_psa9: number | null;
  required_psa10_rate_vs_psa8: number | null;
  estimated_grading_days: number | null;
  estimated_capital_lock_days: number | null;
  annualised_roc_indicator: number | null;
  potential_upcharge: number;
  better_velocity_service_id: string | null;
  reasoning: string | null;
  created_at: string;
  updated_at: string;
}

export interface InventoryRow {
  id: string;
  opportunity_id: string | null;
  card_id: string;
  strategy: Strategy;
  status: "PURCHASED" | "AWAITING_GRADING" | "GRADED" | "LISTED" | "SOLD" | "ARCHIVED";
  actual_purchase_price: number;
  actual_seller_postage: number;
  actual_import_tax: number;
  actual_other_acquisition_fees: number;
  actual_total_acquisition_cost: number;
  source_url: string | null;
  purchased_at: string;
  notes: string | null;
  /** JSON copy of the opportunity as forecast at purchase — never updated,
   *  so realised performance is always compared against what was actually
   *  believed at decision time. */
  forecast_snapshot: string | null;
  forecast_frozen_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface GradingSubmissionRow {
  id: string;
  inventory_id: string;
  service: string;
  submission_level: string | null;
  submitted_at: string;
  tracking_number: string | null;
  actual_grading_fee: number;
  actual_postage_out: number;
  actual_insurance: number;
  actual_packaging: number;
  expected_return_date: string | null;
  status: "SUBMITTED" | "IN_PROGRESS" | "RETURNED";
  created_at: string;
  updated_at: string;
}

export interface GradingResultRow {
  id: string;
  submission_id: string;
  grade_label: string;
  grade_numeric: number;
  cert_number: string | null;
  returned_at: string;
  actual_return_postage: number;
  notes: string | null;
  created_at: string;
}

export interface TransactionRow {
  id: string;
  inventory_id: string;
  sale_price: number;
  sale_platform: string;
  marketplace_fees: number;
  payment_processing_fees: number;
  outbound_postage: number;
  insurance: number;
  packaging: number;
  real_cash_proceeds: number;
  real_net_profit: number;
  real_return_on_capital: number;
  days_held: number;
  sold_at: string;
  buyer_notes: string | null;
  created_at: string;
}

export interface SettingsRow {
  key: string;
  value: string;
  description: string | null;
  updated_at: string;
}

export interface WatchlistCardRow {
  id: string;
  card_id: string | null;
  label: string;
  strategy: "FLIP" | "GRADE" | "BOTH";
  source: string | null;
  priority: number;
  notes: string | null;
  active: number;
  created_at: string;
  updated_at: string;
}

export interface ApiUsageRow {
  id: number;
  provider: string;
  endpoint: string;
  scan_run_id: string | null;
  cache_hit: number;
  cost_weight: number;
  called_at: string;
}
