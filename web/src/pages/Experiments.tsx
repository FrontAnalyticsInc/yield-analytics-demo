import { Link, useNavigate, useParams } from "react-router-dom";
import DesignDiagram from "../DesignDiagram";
import { detectionChance, Factor, Run, settingLabel } from "../doe";
import { dt, num, pct, useApi } from "../lib";

type Summary = { experiment_id: number; name: string; objective: string | null; status: string; created_at: string; created_by: string; created_by_name: string; response: string; factors: number; runs: number };
type Detail = Summary & {
  notes: string | null; response_step_id: number; param_unit: string; lsl: number; target: number; usl: number;
  sigma: number; effect_size: number; alpha: number; power_target: number; replicates: number; center_points: number;
  factors: Factor[]; runs: Run[];
};

const STATUS: Record<string, [string, string]> = {
  planned: ["", "○ planned"], running: ["rework", "▶ running"], complete: ["pass", "✓ complete"], cancelled: ["scrap", "✕ cancelled"],
};
const Status = ({ s }: { s: string }) => <span className={`pill ${STATUS[s]?.[0] ?? ""}`}>{STATUS[s]?.[1] ?? s}</span>;

function ExperimentDetail({ id }: { id: string }) {
  const { data: e, error } = useApi<Detail>(`/api/experiments/${id}`);
  if (error) return <div className="empty">Experiment {id} not found.</div>;
  if (!e) return <div className="empty">Loading…</div>;
  const k = e.factors.length;
  const chance = detectionChance(e.sigma, e.effect_size, e.alpha, e.replicates * 2 ** k);
  return (
    <>
      <p className="sub"><Link to="/experiments">← All experiments</Link></p>
      <h1>{e.name} <Status s={e.status} /></h1>
      <p className="sub">EXP-{String(e.experiment_id).padStart(4, "0")} · by {e.created_by_name} ({e.created_by}) · {dt(e.created_at)}</p>

      <div className="grid g3">
        <div className="card">
          <h2>Design</h2>
          <p className="hint">{2 ** k} corners × {e.replicates}{e.center_points ? ` + ${e.center_points} middle points` : ""} = {e.runs.length} units · {pct(chance, 0)} chance to detect a {num(e.effect_size, 3)} {e.param_unit} change</p>
          <DesignDiagram factors={e.factors} runs={e.runs} />
        </div>
        <div className="card">
          <h2>Summary</h2>
          <dl className="kv">
            {e.objective && <><dt>Objective</dt><dd>{e.objective}</dd></>}
            <dt>Response</dt><dd>{e.response} ({e.param_unit}) · spec {e.lsl} – {e.usl}</dd>
            <dt>Noise σ</dt><dd>{num(e.sigma, 4)} {e.param_unit}</dd>
            <dt>Change to detect</dt><dd>{num(e.effect_size, 4)} {e.param_unit}</dd>
            <dt>Confidence</dt><dd>{pct(1 - e.alpha, 0)} · target {pct(e.power_target, 0)} detection</dd>
            {e.factors.map((f, i) => (
              <span key={i} style={{ display: "contents" }}><dt>Factor {String.fromCharCode(65 + i)}</dt><dd>{f.name}: {settingLabel(f, -1)} / {settingLabel(f, 1)}{f.kind === "categorical" ? " (categorical)" : ""}</dd></span>
            ))}
            {e.notes && <><dt>Notes</dt><dd style={{ whiteSpace: "pre-wrap" }}>{e.notes}</dd></>}
          </dl>
          <p className="hint" style={{ marginTop: 12 }}>Next: tag units to runs and confirm settings (coming in the Run step).</p>
        </div>
      </div>

      <div className="card" style={{ marginTop: 16 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
          <h2>Run sheet</h2>
          <button className="btn" onClick={() => window.print()}>Print</button>
        </div>
        <table>
          <thead><tr><th>Run</th><th>Type</th>{e.factors.map((f, i) => <th key={i}>{f.name}</th>)}<th>Serial</th><th>Ran as planned?</th></tr></thead>
          <tbody>
            {e.runs.map((r) => (
              <tr key={r.runNo}>
                <td>{r.runNo}</td>
                <td>{r.pointType === "center" ? <span className="pill" style={{ color: "var(--series-2)" }}>◆ middle</span> : "corner"}</td>
                {e.factors.map((f, i) => <td key={i}>{settingLabel(f, r.x[i])}</td>)}
                <td style={{ color: "var(--muted)" }}>—</td><td style={{ color: "var(--muted)" }}>—</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

export default function Experiments() {
  const { id } = useParams();
  const nav = useNavigate();
  const list = useApi<Summary[]>(id ? null : "/api/experiments");
  if (id) return <ExperimentDetail id={id} />;
  return (
    <>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12 }}>
        <div>
          <h1>Experiments</h1>
          <p className="sub">Plan a designed experiment to see how two or three settings affect a measurement, then run it on the line.</p>
        </div>
        <Link to="/experiments/new" className="btn primary" style={{ textDecoration: "none" }}>+ New experiment</Link>
      </div>
      <div className="card">
        {list.data?.length === 0 ? (
          <div className="empty">No experiments yet. <Link to="/experiments/new">Design the first one</Link>.</div>
        ) : (
          <table>
            <thead><tr><th>ID</th><th>Name</th><th>Response</th><th className="num">Factors</th><th className="num">Units</th><th>Status</th><th>Created by</th><th>Created</th></tr></thead>
            <tbody>
              {(list.data ?? []).map((x) => (
                <tr key={x.experiment_id} className="clickable" onClick={() => nav(`/experiments/${x.experiment_id}`)}>
                  <td>EXP-{String(x.experiment_id).padStart(4, "0")}</td>
                  <td><Link to={`/experiments/${x.experiment_id}`}>{x.name}</Link></td>
                  <td>{x.response}</td><td className="num">{x.factors}</td><td className="num">{x.runs}</td>
                  <td><Status s={x.status} /></td><td>{x.created_by_name}</td><td>{dt(x.created_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}
