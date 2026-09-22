import { createContext, StrictMode, useContext, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, NavLink, Route, Routes } from "react-router-dom";
import "./styles.css";
import Overview from "./pages/Overview";
import Explorer from "./pages/Explorer";
import Spc from "./pages/Spc";
import Inspections from "./pages/Inspections";
import Units from "./pages/Units";
import Experiments from "./pages/Experiments";
import DoeDesign from "./pages/DoeDesign";

type Filters = { months: number; model: string; start: string; setMonths: (m: number) => void; setModel: (m: string) => void };
const Ctx = createContext<Filters>(null!);
export const useFilters = () => useContext(Ctx);

export function PeriodBar({ models }: { models?: string[] }) {
  const f = useFilters();
  return (
    <>
      <label>Period
        <span className="seg">
          {[3, 6, 12].map((m) => (
            <button key={m} className={f.months === m ? "on" : ""} onClick={() => f.setMonths(m)}>{m} mo</button>
          ))}
        </span>
      </label>
      {models && (
        <label>Model
          <select value={f.model} onChange={(e) => f.setModel(e.target.value)}>
            <option value="">All sizes</option>
            {models.map((m) => <option key={m}>{m}</option>)}
          </select>
        </label>
      )}
    </>
  );
}

function App() {
  const [months, setMonths] = useState(12);
  const [model, setModel] = useState("");
  const start = useMemo(() => {
    const d = new Date();
    d.setMonth(d.getMonth() - months);
    return d.toISOString().slice(0, 10);
  }, [months]);
  return (
    <Ctx.Provider value={{ months, model, start, setMonths, setModel }}>
      <div className="shell">
        <nav className="side">
          <div className="brand">
            <svg width="26" height="26" viewBox="0 0 32 32" aria-hidden><circle cx="16" cy="16" r="13" fill="none" stroke="var(--accent)" strokeWidth="4" /><path d="M16 16V5M16 16l9.5 5.5M16 16l-9.5 5.5" stroke="var(--accent)" strokeWidth="2.5" /></svg>
            <div>Valve Yield<small>Deep-dive analytics</small></div>
          </div>
          <NavLink to="/" end>Overview</NavLink>
          <NavLink to="/explore">Root-cause explorer</NavLink>
          <NavLink to="/spc">SPC &amp; capability</NavLink>
          <NavLink to="/inspections">Image inspections</NavLink>
          <NavLink to="/units">Unit genealogy</NavLink>
          <div className="navhead">Improve</div>
          <NavLink to="/experiments">Experiments</NavLink>
          <div className="foot">Synthetic demo data<br />Front Analytics</div>
        </nav>
        <main>
          <Routes>
            <Route path="/" element={<Overview />} />
            <Route path="/explore" element={<Explorer />} />
            <Route path="/spc" element={<Spc />} />
            <Route path="/inspections" element={<Inspections />} />
            <Route path="/units" element={<Units />} />
            <Route path="/units/:serial" element={<Units />} />
            <Route path="/experiments" element={<Experiments />} />
            <Route path="/experiments/new" element={<DoeDesign />} />
            <Route path="/experiments/:id" element={<Experiments />} />
          </Routes>
        </main>
      </div>
    </Ctx.Provider>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </StrictMode>,
);
