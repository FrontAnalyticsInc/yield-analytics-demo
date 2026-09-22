import { CartesianGrid, ReferenceLine, ResponsiveContainer, Scatter, ScatterChart, Tooltip, XAxis, YAxis } from "recharts";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { PeriodBar, useFilters } from "../main";
import { axisProps, day, dt, num, qs, Tip, useApi, useColors } from "../lib";

type Step = { step_id: number; name: string; step_type: string; param_name: string; param_unit: string; lsl: number; target: number; usl: number };
type Pt = { serial: string; attempt: number; t: string; equipment_id: string; operator_id: string; result: string; value: number };
type Stats = { n: number; mean: number; sd: number; cp: number; cpk: number } | null;
type Resp = { step: Step; points: Pt[]; overall: Stats; by_equipment: Record<string, Stats> };

function Capability({ cpk }: { cpk: number | undefined }) {
  if (cpk == null) return <>—</>;
  const [cls, icon, text] = cpk >= 1.33 ? ["pass", "✓", "capable"] : cpk >= 1.0 ? ["rework", "!", "marginal"] : ["scrap", "✕", "not capable"];
  return <span className={`pill ${cls}`}>{icon} {text}</span>;
}

export default function Spc() {
  const f = useFilters();
  const c = useColors();
  const nav = useNavigate();
  const [sp, setSp] = useSearchParams();
  const meta = useApi<{ steps: Step[] }>("/api/meta");
  const mSteps = (meta.data?.steps ?? []).filter((s) => s.step_type === "measurement");
  // default to the step with the built-in drift story, by name: step ids move when the route changes
  const fallback = mSteps.find((s) => s.name === "Wireform diameter check") ?? mSteps[0];
  const stepId = sp.get("step") ?? (fallback ? String(fallback.step_id) : "");
  const r = useApi<Resp>(stepId ? `/api/spc/${stepId}${qs({ start: f.start })}` : null);
  const d = r.data;
  const stations = Object.keys(d?.by_equipment ?? {});
  const colors = [c.s1, c.s2, c.s3];
  const series = stations.map((eq, i) => ({ eq, color: colors[i % 3], pts: (d?.points ?? []).filter((p) => p.equipment_id === eq).map((p) => ({ ...p, x: +new Date(p.t) })) }));
  const u = d?.step.param_unit ?? "";
  const pad = d ? (d.step.usl - d.step.lsl) * 0.25 : 0;

  return (
    <>
      <h1>SPC &amp; process capability</h1>
      <p className="sub">Every measurement against its spec limits, split by measuring station. <Link to={`/flow?step=${stepId}`}>See this step in the process flow →</Link></p>
      <div className="toolbar">
        <label>Measurement step
          <select value={stepId} onChange={(e) => setSp({ step: e.target.value }, { replace: true })}>
            {mSteps.map((s) => <option key={s.step_id} value={s.step_id}>{s.step_id}. {s.name}</option>)}
          </select>
        </label>
        <PeriodBar />
      </div>

      <div className="tiles">
        <div className="tile"><div className="k">Parameter</div><div className="v" style={{ fontSize: 20 }}>{d?.step.param_name ?? "—"}</div><div className="d">spec {d?.step.lsl} – {d?.step.usl} {u}</div></div>
        <div className="tile"><div className="k">Measurements</div><div className="v">{num(d?.overall?.n)}</div><div className="d">first attempts</div></div>
        <div className="tile"><div className="k">Mean</div><div className="v">{num(d?.overall?.mean, 3)}</div><div className="d">target {d?.step.target} {u}</div></div>
        <div className="tile"><div className="k">Cpk (all stations)</div><div className="v">{num(d?.overall?.cpk, 2)}</div><div className="d"><Capability cpk={d?.overall?.cpk} /></div></div>
      </div>

      <div className="card">
        <h2>{d?.step.name ?? "…"} over time</h2>
        <p className="hint">Dashed lines are spec limits; the dotted line is target · click a point to open the unit</p>
        <div className="legend">{series.map((s) => <span key={s.eq}><i className="sw" style={{ background: s.color, height: 8, width: 8, borderRadius: 4 }} />{s.eq}</span>)}</div>
        <ResponsiveContainer width="100%" height={360}>
          <ScatterChart margin={{ top: 8, right: 56, left: 0, bottom: 0 }}>
            <CartesianGrid stroke={c.grid} vertical={false} />
            <XAxis dataKey="x" type="number" scale="time" domain={["dataMin", "dataMax"]} tickFormatter={(v) => day(new Date(v).toISOString())} {...axisProps(c)} />
            <YAxis dataKey="value" type="number" domain={d ? [d.step.lsl - pad, d.step.usl + pad] : ["auto", "auto"]} tickFormatter={(v) => num(v, 2)} {...axisProps(c)} axisLine={false} width={56} allowDataOverflow />
            {d && <ReferenceLine y={d.step.usl} stroke={c.critical} strokeDasharray="5 4" label={{ value: "USL", position: "right", fill: c.muted, fontSize: 11 }} />}
            {d && <ReferenceLine y={d.step.lsl} stroke={c.critical} strokeDasharray="5 4" label={{ value: "LSL", position: "right", fill: c.muted, fontSize: 11 }} />}
            {d && <ReferenceLine y={d.step.target} stroke={c.axis} strokeDasharray="2 3" label={{ value: "Target", position: "right", fill: c.muted, fontSize: 11 }} />}
            <Tooltip cursor={false} content={({ active, payload }) => active && payload?.length ? (
              <Tip title={payload[0].payload.serial} rows={[
                { name: "Value", value: `${num(payload[0].payload.value, 3)} ${u}` },
                { name: "Station", value: payload[0].payload.equipment_id },
                { name: "Operator", value: payload[0].payload.operator_id },
                { name: "Attempt", value: String(payload[0].payload.attempt) },
                { name: "When", value: dt(payload[0].payload.t) },
              ]} />) : null} />
            {series.map((s) => (
              <Scatter key={s.eq} data={s.pts} fill={s.color} isAnimationActive={false} cursor="pointer"
                shape={(p: { cx?: number; cy?: number }) => <circle cx={p.cx} cy={p.cy} r={3.5} fill={s.color} stroke={c.surface} strokeWidth={1} />}
                onClick={(p: { serial?: string; payload?: Pt }) => nav(`/units/${p.payload?.serial ?? p.serial}`)} />
            ))}
          </ScatterChart>
        </ResponsiveContainer>
      </div>

      <div className="card" style={{ marginTop: 16 }}>
        <h2>Capability by station</h2>
        <table>
          <thead><tr><th>Station</th><th className="num">n</th><th className="num">Mean</th><th className="num">Std dev</th><th className="num">Cp</th><th className="num">Cpk</th><th>Status</th></tr></thead>
          <tbody>
            {stations.map((eq) => { const s = d!.by_equipment[eq]; return (
              <tr key={eq}><td>{eq}</td><td className="num">{num(s?.n)}</td><td className="num">{num(s?.mean, 3)}</td><td className="num">{num(s?.sd, 4)}</td>
                <td className="num">{num(s?.cp, 2)}</td><td className="num">{num(s?.cpk, 2)}</td><td><Capability cpk={s?.cpk} /></td></tr>); })}
          </tbody>
        </table>
      </div>
    </>
  );
}
