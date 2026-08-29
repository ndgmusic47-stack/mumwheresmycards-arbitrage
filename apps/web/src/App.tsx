import { NavLink, Route, Routes } from "react-router-dom";
import { Dashboard } from "./pages/Dashboard";
import { OpportunityDetail } from "./pages/OpportunityDetail";
import { Inventory } from "./pages/Inventory";
import { Pipeline } from "./pages/Pipeline";
import { Watchlist } from "./pages/Watchlist";
import { Market } from "./pages/Market";

export default function App() {
  return (
    <div className="app-shell">
      <header className="app-header">
        <div className="brand">Mum Where&apos;s My Cards — Arbitrage</div>
        <nav className="tabs">
          <NavLink to="/" end>
            Opportunities
          </NavLink>
          <NavLink to="/flip">Flips</NavLink>
          <NavLink to="/grade">Grade</NavLink>
          <NavLink to="/market">Market</NavLink>
          <NavLink to="/inventory">Inventory</NavLink>
          <NavLink to="/pipeline">Pipeline</NavLink>
        </nav>
      </header>

      <main className="app-main">
        <Routes>
          <Route path="/" element={<Dashboard strategyTab="ALL" />} />
          <Route path="/flip" element={<Dashboard strategyTab="FLIP" />} />
          <Route path="/grade" element={<Dashboard strategyTab="GRADE" />} />
          <Route path="/market" element={<Market />} />
          <Route path="/inventory" element={<Inventory />} />
          <Route path="/pipeline" element={<Pipeline />} />
          {/* Not in primary nav per the realignment ("Saved Cards" is a
              secondary feature, not a discovery mechanism) — still reachable
              directly for anyone who has it bookmarked. */}
          <Route path="/watchlist" element={<Watchlist />} />
          <Route path="/opportunity/:id" element={<OpportunityDetail />} />
        </Routes>
      </main>
    </div>
  );
}
