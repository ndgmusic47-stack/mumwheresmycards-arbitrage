import { NavLink, Route, Routes, useLocation } from "react-router-dom";
import { FLIP_ENABLED, DEFAULT_STRATEGY_TAB } from "./state/business";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { Dashboard } from "./pages/Dashboard";
import { OpportunityDetail } from "./pages/OpportunityDetail";
import { Pipeline } from "./pages/Pipeline";
import { Inventory } from "./pages/Inventory";
import { Watchlist } from "./pages/Watchlist";
import { Market } from "./pages/Market";
import { Reconciliation } from "./pages/Reconciliation";

export default function App() {
  // Keyed on the path so navigating anywhere else clears a crashed page —
  // otherwise a boundary that has caught once stays caught for the session.
  const location = useLocation();
  return (
    <div className="app-shell">
      <header className="app-header">
        <div className="brand">Mum Where&apos;s My Cards — Arbitrage</div>
        <nav className="tabs">
          <NavLink to="/" end>
            Opportunities
          </NavLink>
          {/* Flip is parked — see state/business.ts. The tab is hidden
              rather than deleted, and the route below still resolves, so a
              bookmark from before does not 404. */}
          {FLIP_ENABLED && <NavLink to="/flip">Flips</NavLink>}
          <NavLink to="/grade">Grade</NavLink>
          <NavLink to="/market">Market</NavLink>
          <NavLink to="/pipeline">Pipeline</NavLink>
          <NavLink to="/reconciliation">Reconciliation</NavLink>
        </nav>
      </header>

      <main className="app-main">
        <ErrorBoundary label="this page" resetKey={location.pathname}>
        <Routes>
          {/* 2026-09-09: the `key` forces a clean remount per strategy tab.
              Without it React reuses one Dashboard instance across
              /flip -> /grade, so mount-scoped state (the rehydration gate,
              the scroll-restore ref) would carry over from the tab you just
              left. Each tab is its own sourcing session; it should mount
              like one. */}
          {/* With flip parked, "everything" IS the grading view — ALL used
              to mean both, which is why the flip table sat above the
              grading one on the operator's home screen. */}
          <Route path="/" element={<Dashboard key={DEFAULT_STRATEGY_TAB} strategyTab={DEFAULT_STRATEGY_TAB} />} />
          <Route
            path="/flip"
            element={FLIP_ENABLED ? <Dashboard key="FLIP" strategyTab="FLIP" /> : <Dashboard key="GRADE" strategyTab="GRADE" />}
          />
          <Route path="/grade" element={<Dashboard key="GRADE" strategyTab="GRADE" />} />
          <Route path="/market" element={<Market />} />
          <Route path="/pipeline" element={<Pipeline />} />
          <Route path="/reconciliation" element={<Reconciliation />} />
          {/* Not in primary nav. Inventory was removed from the nav on
              2026-09-13: it was a read-only table with no controls, showing
              the same fetchInventory() rows Pipeline already renders across
              its five stage columns with links and spend figures. One worse
              view of the same data does not earn a tab. Both routes stay
              reachable by URL for anyone who bookmarked them. */}
          <Route path="/inventory" element={<Inventory />} />
          <Route path="/watchlist" element={<Watchlist />} />
          <Route path="/opportunity/:id" element={<OpportunityDetail />} />
        </Routes>
        </ErrorBoundary>
      </main>
    </div>
  );
}
