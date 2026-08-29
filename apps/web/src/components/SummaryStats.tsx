import { useEffect, useState } from "react";
import { fetchMarketSummary, type MarketSummary } from "../api/client";

const numberFmt = new Intl.NumberFormat("en-GB");

/**
 * The dashboard's summary header — always live counts from the CARD
 * MARKET / LIVE SUPPLY / OPPORTUNITY tables, never a cached estimate. Per
 * the realignment brief's example: "18,427 Pokémon singles indexed / 6,241
 * with usable PSA market data / 683 dynamic grade candidates / 1,140
 * dynamic flip markets / 7,892 current eBay listings scanned / 8 live
 * opportunities clearing my filters."
 */
export function SummaryStats() {
  const [summary, setSummary] = useState<MarketSummary | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetchMarketSummary()
      .then(setSummary)
      .catch((err) => setError(String(err)));
  }, []);

  if (error) return null; // non-critical — don't block the rest of the dashboard on this
  if (!summary) return <div className="summary-stats summary-stats-loading">Loading summary…</div>;

  const items: { label: string; value: number }[] = [
    { label: "Pokémon singles indexed", value: summary.cardsIndexed },
    { label: "With usable PSA market data", value: summary.cardsWithMarketData },
    { label: "Dynamic grade candidates", value: summary.dynamicGradeCandidates },
    { label: "Dynamic flip markets", value: summary.dynamicFlipMarkets },
    { label: "Current eBay listings scanned", value: summary.ebayListingsScanned },
    { label: "Live opportunities clearing filters", value: summary.liveOpportunities },
  ];

  return (
    <div className="summary-stats">
      {items.map((item) => (
        <div className="summary-stat" key={item.label}>
          <div className="summary-stat-value">{numberFmt.format(item.value)}</div>
          <div className="summary-stat-label">{item.label}</div>
        </div>
      ))}
    </div>
  );
}
