import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { useSearchParams } from "react-router-dom";
import { PeriodBar, useFilters } from "../main";
import { axisProps, num, pct, qs, Tip, useApi, useColors } from "../lib";

type Row = { k: string; attempts: number; fails: number; fail_rate: number };
type Step = { step_id: number; name: string; area: string };
const DIMS: [string, string][] = [
  ["operator", "Operator"], ["equipment", "Station"], ["tissue_lot", "Tissue lot"],
  ["lot", "Build lot"], ["model", "Valve size"], ["month", "Month"],
];
const AREAS = ["Tissue", "Leaflet", "Frame", "Assembly", "Test", "Final"];

export default function Explorer() {
  const f = useFilters();
  const c = useColors();
  const [sp, setSp] = useSearchParams();
  const dim = sp.get("dim") ?? "operator";
  const step = sp.get("step") ?? "";
  const area = sp.get("area") ?? "";
  const set = (k: string, v: string) => { const n = new URLSearchParams(sp); v ? n.set(k, v) : n.delete(k); setSp(n, { replace: true }); };
  const meta = useApi<{ steps: Step[] }>("/api/meta");
  const rows = useApi<Row[]>(`/api/breakdown${qs({ dim, step_id: step, area: step ? "" : area, start: f.start })}`);
  const data = (rows.data ?? []).filter((r) => r.attempts >= 5);
  const overall = data.reduce((a, r) => ({ n: a.n + r.attempts, f: a.f + r.fails }), { n: 0, f: 0 });
  const avg = overall.n ? overall.f / overall.n : 0;
  const scope = step ? meta.data?.steps.find((s) => String(s.step_id) === step)?.name : area || "all steps";

  return (
    <>
      <h1>Root-cause explorer</h1>
      <p className="sub">First-attempt failure rate, sliced by the factor you pick. Look for bars far above the line average.</p>
      <div className="toolbar">
        <label>Slice by
          <span className="seg">{DIMS.map(([k, l]) => <button key={k} className={dim === k ? "on" : ""} onClick={() => set("dim", k)}>{l}</button>)}</span>
        </label>
        <label>Area
          <select value={area} onChange={(e) => { const n = new URLSearchParams(sp); n.delete("step"); e.target.value ? n.set("area", e.target.value) : n.delete("area"); setSp(n, { replace: true }); }}>
            <option value="">All areas</option>{AREAS.map((a) => <option key={a}>{a}</option>)}
          </select>
        </label>
        <label>Step
          <select value={step} onChange={(e) => set("step", e.target.value)}>
            <option value="">All steps in area</option>
            {(meta.data?.steps ?? []).filter((s) => !area || s.area === area).map((s) => <option key={s.step_id} value={s.step_id}>{s.step_id}. {s.name}</option>)}
          </select>
        </label>
        <PeriodBar />
      </div>

      <div className="card">
        <h2>First-attempt fail rate by {DIMS.find((d) => d[0] === dim)?.[1].toLowerCase()} · {scope}</h2>
        <p className="hint">Line average {pct(avg, 2)} across {num(overall.n)} first attempts · groups with fewer than 5 attempts hidden</p>
        {data.length === 0 ? <div className="empty">{rows.loading ? "Loading…" : "No events for this selection."}</div> : (
          <ResponsiveContainer width="100%" height={340}>
            <BarChart data={data} margin={{ top: 20, right: 12, left: 0, bottom: 0 }}>
              <CartesianGrid stroke={c.grid} vertical={false} />
              <XAxis dataKey="k" {...axisProps(c)} interval={data.length > 24 ? "preserveStartEnd" : 0} angle={data.length > 12 ? -35 : 0} textAnchor={data.length > 12 ? "end" : "middle"} height={data.length > 12 ? 60 : 30} />
              <YAxis tickFormatter={(v) => pct(v, 1)} {...axisProps(c)} axisLine={false} width={50} />
              <Tooltip cursor={{ fill: c.grid, opacity: 0.5 }} content={({ active, payload }) => active && payload?.length ? (
                <Tip title={payload[0].payload.k} rows={[
                  { name: "Fail rate", value: pct(payload[0].payload.fail_rate, 2) },
                  { name: "vs average", value: `${(payload[0].payload.fail_rate / (avg || 1)).toFixed(1)}×` },
                  { name: "Fails / attempts", value: `${payload[0].payload.fails} / ${payload[0].payload.attempts}` },
                ]} />) : null} />
              <Bar dataKey="fail_rate" fill={c.s1} radius={[4, 4, 0, 0]} isAnimationActive={false} />
            </BarChart>
          </ResponsiveContainer>
        )}
      </div>

      <div className="card" style={{ marginTop: 16 }}>
        <h2>Table</h2>
        <table>
          <thead><tr><th>{DIMS.find((d) => d[0] === dim)?.[1]}</th><th className="num">First attempts</th><th className="num">Fails</th><th className="num">Fail rate</th><th className="num">vs average</th></tr></thead>
          <tbody>
            {[...data].sort((a, b) => b.fail_rate - a.fail_rate).map((r) => (
              <tr key={r.k}><td>{r.k}</td><td className="num">{num(r.attempts)}</td><td className="num">{num(r.fails)}</td>
                <td className="num">{pct(r.fail_rate, 2)}</td><td className="num">{(r.fail_rate / (avg || 1)).toFixed(1)}×</td></tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
