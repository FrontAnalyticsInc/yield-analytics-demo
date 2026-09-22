import { Bar, BarChart, CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { PeriodBar, useFilters } from "../main";
import { axisProps, label, num, pct, qs, Tip, useApi, useColors } from "../lib";

type Trend = { period: string; completed: number; shipped: number; scrapped: number; fpy: number; final_yield: number };
type Summary = { completed: number; shipped: number; scrapped: number; wip: number; fpy: number; rty: number; final_yield: number; cycle_days: number; trend: Trend[] };
type Step = { step_id: number; name: string; area: string; step_type: string; attempts: number; first_fail: number; rework: number; scrap: number; fpy: number };
type Pareto = { defect_code: string; description: string; category: string; n: number; scrap: number };

export default function Overview() {
  const f = useFilters();
  const c = useColors();
  const nav = useNavigate();
  const [grain, setGrain] = useState<"month" | "week">("month");
  const p = qs({ start: f.start, model: f.model });
  const periodLabel = (v: string) => (grain === "week" ? new Date(`${v}T00:00`).toLocaleDateString(undefined, { month: "short", day: "numeric" }) : v);
  const meta = useApi<{ models: string[] }>("/api/meta");
  const s = useApi<Summary>(`/api/summary${qs({ start: f.start, model: f.model, grain })}`);
  const steps = useApi<Step[]>(`/api/steps${p}`);
  const pareto = useApi<Pareto[]>(`/api/pareto${qs({ start: f.start })}`);
  const drifter = (steps.data ?? []).find((s) => s.name === "Wireform diameter check");
  const worst = (steps.data ?? []).filter((r) => r.first_fail > 0).sort((a, b) => a.fpy - b.fpy).slice(0, 10)
    .map((r) => ({ ...r, loss: 1 - r.fpy, short: `${r.step_id}. ${r.name}` }));
  const d = s.data;

  return (
    <>
      <h1>Manufacturing yield overview</h1>
      <p className="sub">Surgical heart valve line · 53-step routing · first-pass and rolled throughput yield</p>
      <div className="toolbar"><PeriodBar models={meta.data?.models} /></div>

      <div className="tiles">
        <div className="tile"><div className="k">First-pass yield</div><div className="v">{pct(d?.fpy)}</div><div className="d">units with no fail or rework</div></div>
        <div className="tile"><div className="k">Rolled throughput yield</div><div className="v">{pct(d?.rty)}</div><div className="d">product of 53 step yields</div></div>
        <div className="tile"><div className="k">Final yield</div><div className="v">{pct(d?.final_yield)}</div><div className="d">shipped ÷ completed</div></div>
        <div className="tile"><div className="k">Completed</div><div className="v">{num(d?.completed)}</div><div className="d">{num(d?.scrapped)} scrapped</div></div>
        <div className="tile"><div className="k">Work in process</div><div className="v">{num(d?.wip)}</div><div className="d">units on the line now</div></div>
        <div className="tile"><div className="k">Avg cycle time</div><div className="v">{num(d?.cycle_days, 1)} d</div><div className="d">start → release</div></div>
      </div>

      <div className="grid g2">
        <div className="card">
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12 }}>
            <div>
              <h2>Yield by {grain}</h2>
              <p className="hint">By {grain} of completion{grain === "week" ? ", Monday start" : ""}</p>
            </div>
            <span className="seg" style={{ flexShrink: 0 }}>
              {(["week", "month"] as const).map((g) => (
                <button key={g} className={grain === g ? "on" : ""} onClick={() => setGrain(g)}>{g === "week" ? "Week" : "Month"}</button>
              ))}
            </span>
          </div>
          <div className="legend">
            <span><i className="sw" style={{ background: c.s1 }} />First-pass yield</span>
            <span><i className="sw" style={{ background: c.s2 }} />Final yield</span>
          </div>
          <ResponsiveContainer width="100%" height={260}>
            <LineChart data={d?.trend ?? []} margin={{ top: 8, right: 16, left: 0, bottom: 0 }}>
              <CartesianGrid stroke={c.grid} vertical={false} />
              <XAxis dataKey="period" tickFormatter={periodLabel} minTickGap={16} {...axisProps(c)} />
              <YAxis domain={grain === "week" ? [0.3, 1] : [0.5, 1]} ticks={grain === "week" ? [0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1] : [0.5, 0.6, 0.7, 0.8, 0.9, 1]} allowDataOverflow tickFormatter={(v) => pct(v, 0)} {...axisProps(c)} axisLine={false} width={44} />
              <Tooltip cursor={{ stroke: c.axis }} content={({ active, payload }) => active && payload?.length ? (
                <Tip title={grain === "week" ? `Week of ${periodLabel(payload[0].payload.period)}` : payload[0].payload.period} rows={[
                  { name: "First-pass yield", value: pct(payload[0].payload.fpy), color: c.s1 },
                  { name: "Final yield", value: pct(payload[0].payload.final_yield), color: c.s2 },
                  { name: "Completed", value: num(payload[0].payload.completed) },
                ]} />) : null} />
              <Line dataKey="fpy" stroke={c.s1} strokeWidth={2} dot={grain === "month" ? { r: 3, strokeWidth: 0, fill: c.s1 } : false} activeDot={{ r: 5, stroke: c.surface, strokeWidth: 2 }} isAnimationActive={false} />
              <Line dataKey="final_yield" stroke={c.s2} strokeWidth={2} dot={grain === "month" ? { r: 3, strokeWidth: 0, fill: c.s2 } : false} activeDot={{ r: 5, stroke: c.surface, strokeWidth: 2 }} isAnimationActive={false} />
            </LineChart>
          </ResponsiveContainer>
        </div>

        <div className="card">
          <h2>Where yield is lost</h2>
          <p className="hint">Ten steps with the lowest first-pass yield · click to explore</p>
          <ResponsiveContainer width="100%" height={280}>
            <BarChart data={worst} layout="vertical" margin={{ top: 0, right: 40, left: 0, bottom: 0 }} barCategoryGap={4}>
              <XAxis type="number" hide domain={[0, "dataMax"]} />
              <YAxis type="category" dataKey="short" width={210} {...axisProps(c)} axisLine={false} tick={{ fill: c.ink2, fontSize: 12 }} />
              <Tooltip cursor={{ fill: c.grid, opacity: 0.5 }} content={({ active, payload }) => active && payload?.length ? (
                <Tip title={payload[0].payload.short} rows={[
                  { name: "First-pass yield", value: pct(payload[0].payload.fpy) },
                  { name: "First-attempt fails", value: `${payload[0].payload.first_fail} of ${payload[0].payload.attempts}` },
                  { name: "Scrapped here", value: num(payload[0].payload.scrap) },
                ]} />) : null} />
              <Bar dataKey="loss" fill={c.s1} radius={[0, 4, 4, 0]} isAnimationActive={false} cursor="pointer"
                label={{ position: "right", fill: c.ink2, fontSize: 11.5, formatter: (v: unknown) => pct(v as number) }}
                onClick={(e: { payload?: Step }) => e.payload && nav(`/explore?step=${e.payload.step_id}`)} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </div>

      <div className="grid g3" style={{ marginTop: 16 }}>
        <div className="card">
          <h2>Defect Pareto</h2>
          <p className="hint">All non-pass events in the period</p>
          <ResponsiveContainer width="100%" height={250}>
            <BarChart data={(pareto.data ?? []).map((r) => ({ ...r, l: label(r.defect_code) }))} margin={{ top: 16, right: 8, left: 0, bottom: 0 }}>
              <CartesianGrid stroke={c.grid} vertical={false} />
              <XAxis dataKey="l" {...axisProps(c)} interval={0} tick={{ fill: c.muted, fontSize: 11 }} />
              <YAxis {...axisProps(c)} axisLine={false} width={36} />
              <Tooltip cursor={{ fill: c.grid, opacity: 0.5 }} content={({ active, payload }) => active && payload?.length ? (
                <Tip title={payload[0].payload.description} rows={[
                  { name: "Events", value: num(payload[0].payload.n) },
                  { name: "Led to scrap", value: num(payload[0].payload.scrap) },
                  { name: "Category", value: payload[0].payload.category },
                ]} />) : null} />
              <Bar dataKey="n" fill={c.s1} radius={[4, 4, 0, 0]} isAnimationActive={false} label={{ position: "top", fill: c.ink2, fontSize: 11.5 }} />
            </BarChart>
          </ResponsiveContainer>
        </div>
        <div className="card">
          <h2>What the data is saying</h2>
          <p className="hint">Built-in stories to find during the demo</p>
          <p className="story"><Link to={`/spc?step=${drifter?.step_id ?? ""}`}>Wireform diameter</Link>: station MS-{String(drifter?.step_id ?? 0).padStart(2, "0")}-2 drifted high mid-May → early July 2026.</p>
          <p className="story"><Link to="/explore?dim=tissue_lot&area=Tissue">Tissue lot PT-2606-B</Link>: calcific spots well above other lots.</p>
          <p className="story"><Link to="/explore?dim=operator&area=Assembly">Operator OP-07</Link>: new-hire suture learning curve since March.</p>
          <p className="story"><Link to="/inspections?mismatch=1">Vision model</Link>: misses faint fibers the inspectors catch.</p>
        </div>
      </div>
    </>
  );
}
