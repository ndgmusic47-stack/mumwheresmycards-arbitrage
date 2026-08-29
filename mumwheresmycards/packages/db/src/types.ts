// Row types mirroring apps/worker/migrations/*.sql. Kept hand-written and
// in sync deliberately (no generator) since D1 migrations are the source of
// truth for shape but TypeScript needs its own literal unions for safety.

export type Strategy = "FLIP" | "GRADE";

export type Liquidity = "LOW" | "MEDIUM" | "HIGH" | "VERY_HIGH";

export type OpportunityState =
  | "HIGH_CONFIDENCE_FLIP"
  | "GRADE_CANDIDATE"
  | "INSPECT_PHOTOS"
  | "WATCH"
  | "PASS"
  | "REJECTED_CARD_IDENTITY_UNCERTAIN"
  | "REJECTED_MARGIN_TOO_LOW"
  | "REJECTED_LIQUIDITY_TOO_LOW";

export interface CardRow {
  id: string;
  game: string;
  name: string;
  set_name: string;
  set_code: string;
  card_number: string;
  year: number;
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
}

export interface MarketSnapshotRow {
  id: number;
  card_id: string;
  source_provider: string;
  captured_at: string;
  price_timestamp: string;
  raw_market_price: number | null;
  raw_qsv: number | null;
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
  seller_username: string | null;
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
  flip_score: number | null;
  grade_score: number | null;
  listing_price: number;
  total_acquisition_cost: number;
  liquidity: Liquidity;
  confidence: number;
  qsv: number | null;
  expected_net_sale_proceeds: number | null;
  expected_net_profit: number | null;
  return_on_capital: number | null;
  profit_margin: number | null;
  days_to_sale_estimate: number | null;
  total_graded_basis: number | null;
  psa6_profit: number | null;
  psa7_profit: number | null;
  psa8_profit: number | null;
  psa9_profit: number | null;
  psa10_profit: number | null;
  break_even_grade: string | null;
  psa10_upside_multiple: number | null;
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
