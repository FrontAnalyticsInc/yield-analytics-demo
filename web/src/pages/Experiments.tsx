import { useEffect, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import DesignDiagram, { pointKey } from "../DesignDiagram";
import { EffectsChart, InteractionPlot, MainEffects } from "../DoeCharts";
import { detectionChance, Factor, settingLabel } from "../doe";
import { dt, num, pct, seq, useApi, useColors } from "../lib";

type Summary = {
  experiment_id: number; name: string; objective: string | null; status: string; created_at: string; created_by: string;
  created_by_name: string; response: string; factors: number; runs: number; tagged: number; measured: number;
};
type RunRow = {
  runNo: number; pointType: "corner" | "center"; replicate: number; x: number[]; planned: number[];
  serial: string | null; simulated: boolean; unitStatus: string | null; assignedBy: string | null; confirmedBy: string | null;
  confirmedAt: string | null; asPlanned: boolean | null; actual: number[] | null; actualCoded: number[] | null;
  deviationNote: string | null; response: number | null; responseSource: string | null;
  state: "planned" | "assigned" | "confirmed" | "measured";
};
type Detail = Omit<Summary, "factors" | "runs"> & {
  notes: string | null; response_step_id: number; param_unit: string; lsl: number; target: number; usl: number;
  sigma: number; effect_size: number; alpha: number; power_target: number; replicates: number; center_points: number;
  factors: Factor[]; runs: RunRow[]; progress: Record<string, number>;
};
type MeanCI = { n: number; mean: number | null; lo: number | null; hi: number | null };
type Analysis = {
  ready: boolean; message?: string; n: number; planned: number; k: number; df: number; s: number; r2: number;
  achievedPower: number | null; unit: string; target: number | null; lsl: number | null; usl: number | null;
  headlines: { factor: string; verdict: string; text: string }[];
  model: { term: string; kind: string; effect: number; se: number; lo: number; hi: number; p: number; verdict: string | null }[];
  mainPlots: { factor: string; low: MeanCI; high: MeanCI }[];
  interactionPlots: { a: number; b: number; cells: Record<string, MeanCI> }[];
  predictions: { x: number[]; pred: number; lo: number; hi: number; observed: number | null; n: number; inSpec: boolean }[];
  best: { x: number[]; pred: number; lo: number; hi: number };
  centerMeans: Record<string, number>;
  notes: { level: "ok" | "info" | "warn"; text: string }[];
  truth: { effects: { factor: string; effect: number }[]; interactions: { term: string; effect: number }[]; curvature: number; drift: number; noise: number } | null;
};

const STATUS: Record<string, [string, string]> = {
  planned: ["", "○ planned"], running: ["rework", "▶ running"], complete: ["pass", "✓ complete"], cancelled: ["scrap", "✕ cancelled"],
};
const Status = ({ s }: { s: string }) => <span className={`pill ${STATUS[s]?.[0] ?? ""}`}>{STATUS[s]?.[1] ?? s}</span>;
const STATE: Record<RunRow["state"], [string, string]> = {
  planned: ["", "○ planned"], assigned: ["", "◔ unit tagged"], confirmed: ["rework", "◑ settings confirmed"], measured: ["pass", "● result in"],
};
const VERDICT: Record<string, [string, string]> = { real: ["pass", "✓ real effect"], none: ["", "– no meaningful effect"], unclear: ["rework", "? unclear"] };
const eid4 = (id: number) => `EXP-${String(id).padStart(4, "0")}`;

async function post(url: string, body?: unknown, method = "POST") {
  const r = await fetch(url, { method, headers: { "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  if (!r.ok) {
    const d = await r.json().catch(() => null);
    throw new Error(typeof d?.detail === "string" ? d.detail : Array.isArray(d?.detail) ? d.detail[0]?.msg : r.statusText);
  }
  return r.json();
}

function useOperator(): [string, (v: string) => void] {
  const [op, setOp] = useState(() => { try { return localStorage.getItem("yield.operator") ?? ""; } catch { return ""; } });
  return [op, (v) => { setOp(v); try { localStorage.setItem("yield.operator", v); } catch { /* private mode */ } }];
}

// --- Run tab ------------------------------------------------------------------------------

function RunRowView({ e, r, operator, reload, setError }: { e: Detail; r: RunRow; operator: string; reload: () => void; setError: (s: string | null) => void }) {
  const [serial, setSerial] = useState("");
  const [editing, setEditing] = useState(false);
  const [actual, setActual] = useState<number[]>(r.planned);
  const [note, setNote] = useState("");
  const [manual, setManual] = useState("");
  const open = e.status === "planned" || e.status === "running";
  const act = (f: () => Promise<unknown>) => { setError(null); f().then(reload).catch((err) => setError(`Run ${r.runNo}: ${err.message}`)); };
  const base = `/api/experiments/${e.experiment_id}/runs/${r.runNo}`;
  const needOp = () => { if (!operator) { setError("Pick who you are (top of the Run tab) first."); return true; } return false; };

  return (
    <tr className={r.asPlanned === false ? "dev" : undefined}>
      <td>{r.runNo}</td>
      <td>{r.pointType === "center" ? <span className="pill" style={{ color: "var(--series-2)" }}>◆ middle</span> : "corner"}</td>
      {e.factors.map((f, i) => (
        <td key={i}>
          {settingLabel(f, r.x[i])}
          {r.asPlanned === false && r.actual && r.actual[i] !== r.planned[i] && (
            <div className="actual">ran at {f.kind === "categorical" ? settingLabel(f, r.actual[i]) : `${+r.actual[i].toFixed(4)} ${f.units}`}</div>
          )}
        </td>
      ))}
      <td>
        {r.serial ? (
          <span className="mono">{r.serial}{r.simulated && <span className="pill" style={{ marginLeft: 6 }}>sim</span>}
            {open && r.state === "assigned" && <button className="linkbtn" style={{ marginLeft: 6 }} aria-label={`Untag ${r.serial}`} onClick={() => act(() => post(`${base}/assign`, undefined, "DELETE"))}>×</button>}
          </span>
        ) : open ? (
          <form className="inline" onSubmit={(ev) => { ev.preventDefault(); if (!needOp() && serial.trim()) act(() => post(`${base}/assign`, { serial, operator }).then(() => setSerial(""))); }}>
            <input type="text" list="eligible" placeholder="Serial" value={serial} onChange={(ev) => setSerial(ev.target.value)} style={{ width: 120, minWidth: 0 }} />
            <button className="btn sm">Tag</button>
          </form>
        ) : <span className="muted">—</span>}
      </td>
      <td>
        {r.asPlanned === true && <span className="pill pass">✓ as planned</span>}
        {r.asPlanned === false && <span className="pill rework" title={r.deviationNote ?? ""}>! different</span>}
        {r.asPlanned == null && r.serial && open && !editing && (
          <span style={{ display: "inline-flex", gap: 6 }}>
            <button className="btn sm" onClick={() => !needOp() && act(() => post(`${base}/confirm`, { operator, as_planned: true }))}>✓ Ran as planned</button>
            <button className="btn sm" onClick={() => setEditing(true)}>Different…</button>
          </span>
        )}
        {editing && (
          <div className="devform">
            {e.factors.map((f, i) => (
              <label key={i}>{f.name}
                {f.kind === "categorical" ? (
                  <select value={actual[i]} onChange={(ev) => setActual(actual.map((v, j) => (j === i ? +ev.target.value : v)))}>
                    <option value={-1}>{f.lowLabel}</option><option value={1}>{f.highLabel}</option>
                  </select>
                ) : (
                  <input type="number" step="any" value={actual[i]} onChange={(ev) => setActual(actual.map((v, j) => (j === i ? parseFloat(ev.target.value) : v)))} style={{ width: 90, minWidth: 0 }} />
                )}
              </label>
            ))}
            <label>Why?<input type="text" value={note} onChange={(ev) => setNote(ev.target.value)} placeholder="e.g. setpoint drifted" /></label>
            <span style={{ display: "flex", gap: 6 }}>
              <button className="btn sm primary" onClick={() => !needOp() && act(() => post(`${base}/confirm`, { operator, as_planned: false, actual, note }).then(() => setEditing(false)))}>Save actual</button>
              <button className="btn sm" onClick={() => setEditing(false)}>Cancel</button>
            </span>
          </div>
        )}
      </td>
      <td className="num">
        {r.response != null ? (
          <span title={r.responseSource === "line" ? "From the line measurement" : r.responseSource ?? ""}>
            {num(r.response, 3)} <span className="muted" style={{ fontSize: 11 }}>{r.responseSource === "line" ? "line" : r.responseSource === "simulated" ? "sim" : "manual"}</span>
          </span>
        ) : r.asPlanned != null && open ? (
          <form className="inline" onSubmit={(ev) => { ev.preventDefault(); const v = parseFloat(manual); if (!Number.isNaN(v)) act(() => post(`${base}/response`, { value: v })); }}>
            <input type="number" step="any" placeholder="waiting for line" value={manual} onChange={(ev) => setManual(ev.target.value)} style={{ width: 120, minWidth: 0 }} />
            <button className="btn sm" disabled={!manual}>Enter</button>
          </form>
        ) : <span className="muted">—</span>}
      </td>
      <td><span className={`pill ${STATE[r.state][0]}`}>{STATE[r.state][1]}</span></td>
    </tr>
  );
}

function RunTab({ e, reload }: { e: Detail; reload: () => void }) {
  const [operator, setOperator] = useOperator();
  const ops = useApi<{ operators: { operator_id: string; name: string }[] }>("/api/meta");
  const eligible = useApi<{ serial: string; last_step: number | null; model: string }[]>(`/api/experiments/${e.experiment_id}/eligible-units?v=${e.progress.assigned}`);
  const [error, setError] = useState<string | null>(null);
  const [sel, setSel] = useState<string | null>(null);
  const p = e.progress, total = e.runs.length;
  const rows = sel ? e.runs.filter((r) => pointKey(r) === sel) : e.runs;
  const devs = e.runs.filter((r) => r.asPlanned === false && r.actualCoded).map((r) => ({ planned: r.x, actual: r.actualCoded!, runNo: r.runNo }));

  return (
    <>
      <div className="grid g2">
        <div className="card">
          <h2>Progress</h2>
          <div className="progress" role="img" aria-label={`${p.measured} of ${total} results in`}>
            {(["measured", "confirmed", "assigned"] as const).map((s) => (
              <span key={s} className={`seg-${s}`} style={{ width: `${(p[s] / total) * 100}%` }} />
            ))}
          </div>
          <div className="legend" style={{ marginTop: 8 }}>
            <span><i className="sw" style={{ background: "var(--good)", height: 8 }} />{p.measured} result in</span>
            <span><i className="sw" style={{ background: "var(--warning)", height: 8 }} />{p.confirmed} settings confirmed</span>
            <span><i className="sw" style={{ background: "var(--seq-100)", height: 8 }} />{p.assigned} unit tagged</span>
            <span><i className="sw" style={{ background: "var(--grid)", height: 8 }} />{p.planned} to do</span>
          </div>
          <p className="hint" style={{ marginTop: 10 }}>
            1. <b>Tag</b> an in-process unit to each run (a unit can only be in one experiment). 2. At the step, <b>confirm</b> the settings ran as planned, or record what actually ran.
            3. The <b>result</b> arrives automatically when the unit reaches {e.response}, or can be entered by hand.
          </p>
          <label className="field" style={{ maxWidth: 280 }}>You are
            <select value={operator} onChange={(ev) => setOperator(ev.target.value)}>
              <option value="">Select operator…</option>
              {(ops.data?.operators ?? []).map((o) => <option key={o.operator_id} value={o.operator_id}>{o.name} ({o.operator_id})</option>)}
            </select>
          </label>
        </div>
        <details className="card" open>
          <summary><h2 style={{ display: "inline" }}>Design</h2> <span className="hint">ring = share of runs with a result · click a point to filter</span></summary>
          <DesignDiagram factors={e.factors} runs={e.runs} overlay={{
            ring: (pt) => pt.runs.filter((r) => (r as unknown as RunRow).state === "measured").length / pt.runs.length,
            label: (pt) => `${pt.runs.filter((r) => (r as unknown as RunRow).state === "measured").length}/${pt.runs.length}`,
            deviations: devs, selected: sel, onSelect: setSel,
          }} />
          {devs.length > 0 && <p className="hint">Red rings: runs that used a different setting than planned.</p>}
        </details>
      </div>

      <div className="card" style={{ marginTop: 16 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 12, flexWrap: "wrap" }}>
          <h2>Runs {sel && <button className="linkbtn" onClick={() => setSel(null)}>(filtered · show all)</button>}</h2>
          <span className="hint">{(eligible.data ?? []).length} eligible in-process units · type or pick a serial</span>
        </div>
        {error && <ul className="errs"><li>{error}</li></ul>}
        <datalist id="eligible">{(eligible.data ?? []).map((u) => <option key={u.serial} value={u.serial}>{`${u.model} · at step ${u.last_step ?? 0}`}</option>)}</datalist>
        <div style={{ overflowX: "auto" }}>
          <table className="runs">
            <thead><tr><th>Run</th><th>Type</th>{e.factors.map((f, i) => <th key={i}>{f.name}</th>)}<th>Unit</th><th>Settings</th><th className="num">Result ({e.param_unit})</th><th>Status</th></tr></thead>
            <tbody>{rows.map((r) => (
              <RunRowView key={r.runNo} e={e} r={r} operator={operator} reload={reload} setError={setError} />
            ))}</tbody>
          </table>
        </div>
      </div>
    </>
  );
}

// --- Analyze tab ------------------------------------------------------------------------------

function AnalyzeTab({ e, simulate, busy }: { e: Detail; simulate: () => void; busy: boolean }) {
  const c = useColors();
  const { data: a, loading } = useApi<Analysis>(`/api/experiments/${e.experiment_id}/analysis?v=${e.progress.measured}`);
  if (loading && !a) return <div className="empty">Analysing…</div>;
  if (!a) return <div className="empty">Analysis unavailable.</div>;
  if (!a.ready)
    return (
      <div className="card empty">
        <p>{a.message}</p>
        {(e.status === "planned" || e.status === "running") && <button className="btn primary" disabled={busy} onClick={simulate}>Simulate results</button>}
      </div>
    );

  const u = a.unit;
  const labels = e.factors.map((f) => [settingLabel(f, -1), settingLabel(f, 1)] as [string, string]);
  const vals = [
    ...a.mainPlots.flatMap((m) => [m.low.lo, m.low.hi, m.high.lo, m.high.hi]),
    ...a.interactionPlots.flatMap((ip) => Object.values(ip.cells).flatMap((m) => [m.mean])),
  ].filter((v): v is number => v != null);
  const pad = (Math.max(...vals) - Math.min(...vals)) * 0.12 || e.sigma;
  const domain: [number, number] = [Math.min(...vals) - pad, Math.max(...vals) + pad];
  const predRange = [Math.min(...a.predictions.map((p) => p.pred)), Math.max(...a.predictions.map((p) => p.pred))];
  const bestKey = `corner:${a.best.x.join(",")}`;
  const predByKey = Object.fromEntries(a.predictions.map((p) => [`corner:${p.x.join(",")}`, p]));
  const settings = (x: number[]) => e.factors.map((f, i) => `${settingLabel(f, x[i])}`).join(" · ");
  const est = (term: string) => a.model.find((m) => m.term === term)?.effect;

  return (
    <>
      <div className="card">
        <h2>What the experiment says</h2>
        <p className="hint">{a.n} of {a.planned} runs analysed · noise in this experiment σ = {num(a.s, 4)} {u} · the model explains {pct(a.r2, 0)} of the variation</p>
        <div className="headlines">
          {a.headlines.map((h) => (
            <div key={h.factor} className={`headline-row v-${h.verdict}`}>
              <span className={`pill ${VERDICT[h.verdict][0]}`}>{VERDICT[h.verdict][1]}</span>
              <span>{h.text}</span>
            </div>
          ))}
        </div>
        <div className="bestbox">
          <div className="k">Best settings{a.target != null ? ` for the ${num(a.target, 3)} ${u} target` : ""}</div>
          <div className="v">{settings(a.best.x)}</div>
          <div className="hint">Predicted {num(a.best.pred, 3)} {u} (95% range {num(a.best.lo, 3)} – {num(a.best.hi, 3)})</div>
        </div>
      </div>

      <div className="grid g2" style={{ marginTop: 16 }}>
        <div className="card">
          <h2>Size of each effect</h2>
          <p className="hint">Change in {e.response.toLowerCase()} going from low to high. Bars are the 95% range; a bar crossing zero isn't proven.</p>
          <EffectsChart terms={a.model} delta={e.effect_size} unit={u} />
        </div>
        <div className="card">
          <h2>Results on the design</h2>
          <p className="hint">Predicted {e.response.toLowerCase()} at each corner (darker = higher) · outlined = best</p>
          <DesignDiagram factors={e.factors} runs={e.runs} overlay={{
            label: (pt) => {
              if (pt.runs[0].pointType === "center") { const m = a.centerMeans[pt.x.join(",")]; return m != null ? num(m, 3) : "—"; }
              const p = predByKey[pt.key]; return p ? num(p.pred, 3) : "—";
            },
            fill: (pt) => {
              if (pt.runs[0].pointType === "center") return undefined;
              const p = predByKey[pt.key];
              return p ? seq((p.pred - predRange[0]) / (predRange[1] - predRange[0] || 1) * 0.85 + 0.15, c.seqLo, c.seqHi) : undefined;
            },
            selected: bestKey,
            tooltip: (pt) => { const p = predByKey[pt.key]; return p ? `Predicted ${num(p.pred, 3)} ${u}; observed mean ${p.observed != null ? num(p.observed, 3) : "—"} (n=${p.n})` : ""; },
          }} />
        </div>
      </div>

      <div className="grid" style={{ marginTop: 16 }}>
        <div className="card">
          <h2>Main effects</h2>
          <p className="hint">Average result at the low and high setting of each factor · steeper line = bigger effect</p>
          <div style={{ maxWidth: 230 * a.mainPlots.length }}><MainEffects plots={a.mainPlots} labels={labels} domain={domain} unit={u} target={a.target} /></div>
        </div>
        <div className="card">
          <h2>Interactions</h2>
          {a.interactionPlots.length === 0 ? <p className="hint">Single-factor experiment: no interactions to check.</p> : (
            <>
              <p className="hint">Parallel lines mean the factors act independently; crossing or diverging lines mean they interact.</p>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(280px, 380px))", gap: 16 }}>
                {a.interactionPlots.map((ip) => (
                  <InteractionPlot key={`${ip.a}${ip.b}`} cells={ip.cells} aName={e.factors[ip.a].name} bName={e.factors[ip.b].name}
                    aLabels={labels[ip.a]} bLabels={labels[ip.b]} domain={domain} unit={u} />
                ))}
              </div>
            </>
          )}
        </div>
      </div>

      <div className="grid g2" style={{ marginTop: 16 }}>
        <div className="card">
          <h2>Checks</h2>
          <ul className="checks">
            {a.achievedPower != null && (
              <li className={a.achievedPower >= e.power_target - 0.01 ? "ok" : "warn"}>
                With the noise actually seen, this experiment had a {pct(a.achievedPower, 0)} chance to detect a {num(e.effect_size, 3)} {u} change (planned {pct(e.power_target, 0)}).
              </li>
            )}
            {a.notes.map((n, i) => <li key={i} className={n.level}>{n.text}</li>)}
          </ul>
        </div>
        <div className="card">
          <h2>Predicted result at every corner</h2>
          <table>
            <thead><tr>{e.factors.map((f, i) => <th key={i}>{f.name}</th>)}<th className="num">Predicted</th><th className="num">Observed</th><th>Spec</th></tr></thead>
            <tbody>
              {[...a.predictions].sort((p, q) => (a.target != null ? Math.abs(p.pred - a.target) - Math.abs(q.pred - a.target) : q.pred - p.pred)).map((p) => (
                <tr key={p.x.join()} style={{ fontWeight: `corner:${p.x.join(",")}` === bestKey ? 600 : undefined }}>
                  {e.factors.map((f, i) => <td key={i}>{settingLabel(f, p.x[i])}</td>)}
                  <td className="num">{num(p.pred, 3)} <span className="muted">±{num((p.hi - p.lo) / 2, 3)}</span></td>
                  <td className="num">{p.observed != null ? `${num(p.observed, 3)} (n=${p.n})` : "—"}</td>
                  <td>{p.inSpec ? <span className="pill pass">✓ in spec</span> : <span className="pill scrap">✕ at risk</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <details className="card" style={{ marginTop: 16 }}>
        <summary><h2 style={{ display: "inline" }}>Model details</h2></summary>
        <table style={{ marginTop: 10 }}>
          <thead><tr><th>Term</th><th className="num">Effect ({u})</th><th className="num">95% range</th><th className="num">p-value</th><th>Verdict</th></tr></thead>
          <tbody>
            {a.model.map((m) => (
              <tr key={m.term}>
                <td>{m.term}</td><td className="num">{num(m.effect, 4)}</td>
                <td className="num">{num(m.lo, 4)} to {num(m.hi, 4)}</td>
                <td className="num">{m.kind === "intercept" ? "" : m.p < 0.001 ? "<0.001" : m.p.toFixed(3)}</td>
                <td>{m.verdict ? <span className={`pill ${VERDICT[m.verdict][0]}`}>{VERDICT[m.verdict][1]}</span> : "average result"}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="hint" style={{ marginTop: 8 }}>Least-squares fit on the settings actually run, coded −1 (low) to +1 (high). Effect = change from low to high. {a.df} degrees of freedom for noise.</p>
      </details>

      {a.truth && (
        <details className="card" style={{ marginTop: 16 }}>
          <summary><h2 style={{ display: "inline" }}>Reveal the simulated truth</h2> <span className="hint">how close did the analysis get?</span></summary>
          <table style={{ marginTop: 10 }}>
            <thead><tr><th>Effect</th><th className="num">True (simulated)</th><th className="num">Estimated</th></tr></thead>
            <tbody>
              {a.truth.effects.map((t) => <tr key={t.factor}><td>{t.factor}</td><td className="num">{num(t.effect, 4)}</td><td className="num">{num(est(t.factor), 4)}</td></tr>)}
              {a.truth.interactions.map((t) => <tr key={t.term}><td>{t.term}</td><td className="num">{num(t.effect, 4)}</td><td className="num">{est(t.term) != null ? num(est(t.term), 4) : "not estimated"}</td></tr>)}
              {a.model.some((m) => m.kind === "curvature") && <tr><td>Curvature</td><td className="num">{num(a.truth.curvature, 4)}</td><td className="num">{num(est("Curvature (middle vs corners)"), 4)}</td></tr>}
              <tr><td>Drift over the run order</td><td className="num">{num(a.truth.drift, 4)}</td><td className="num muted">see checks</td></tr>
              <tr><td>Noise σ</td><td className="num">{num(a.truth.noise, 4)}</td><td className="num">{num(a.s, 4)}</td></tr>
            </tbody>
          </table>
        </details>
      )}
    </>
  );
}

// --- page ---------------------------------------------------------------------------------------

function ExperimentDetail({ id }: { id: string }) {
  const [v, setV] = useState(0);
  const { data: e, error } = useApi<Detail>(`/api/experiments/${id}?v=${v}`);
  const [sp, setSp] = useSearchParams();
  const tab = sp.get("tab") ?? "design";
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const reload = () => setV((x) => x + 1);
  useEffect(() => { setErr(null); }, [tab]);
  if (error) return <div className="empty">Experiment {id} not found.</div>;
  if (!e) return <div className="empty">Loading…</div>;
  const k = e.factors.length;
  const chance = detectionChance(e.sigma, e.effect_size, e.alpha, e.replicates * 2 ** k);
  const open = e.status === "planned" || e.status === "running";
  const hasSim = e.runs.some((r) => r.simulated || r.responseSource === "simulated");
  const run = (f: () => Promise<unknown>, next?: string) => {
    setBusy(true); setErr(null);
    f().then(() => { reload(); if (next) setSp({ tab: next }); }).catch((x) => setErr(x.message)).finally(() => setBusy(false));
  };

  return (
    <>
      <p className="sub"><Link to="/experiments">← All experiments</Link></p>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap", alignItems: "flex-start" }}>
        <div>
          <h1>{e.name} <Status s={e.status} /></h1>
          <p className="sub">{eid4(e.experiment_id)} · by {e.created_by_name} ({e.created_by}) · {dt(e.created_at)}{e.objective ? ` · ${e.objective}` : ""}</p>
        </div>
        <div className="actions">
          {open && e.progress.measured < e.runs.length && <button className="btn primary" disabled={busy} onClick={() => run(() => post(`/api/experiments/${e.experiment_id}/simulate`), "analyze")}>Simulate results</button>}
          {hasSim && e.status !== "cancelled" && <button className="btn" disabled={busy} onClick={() => run(() => post(`/api/experiments/${e.experiment_id}/reset-simulation`))}>Clear simulation</button>}
          {open && e.progress.measured > 0 && <button className="btn" disabled={busy} onClick={() => run(() => post(`/api/experiments/${e.experiment_id}/status`, { status: "complete" }))}>Mark complete</button>}
          {e.status === "complete" && <button className="btn" disabled={busy} onClick={() => run(() => post(`/api/experiments/${e.experiment_id}/status`, { status: "running" }))}>Reopen</button>}
          {open && <button className="btn" disabled={busy} onClick={() => { if (confirm("Cancel this experiment? Tagged units are released.")) run(() => post(`/api/experiments/${e.experiment_id}/status`, { status: "cancelled" })); }}>Cancel</button>}
        </div>
      </div>
      {err && <ul className="errs" style={{ marginBottom: 10 }}><li>{err}</li></ul>}

      <div className="tabs" role="tablist">
        {[["design", "1 · Design"], ["run", `2 · Run (${e.progress.measured}/${e.runs.length})`], ["analyze", "3 · Analyze"]].map(([t, l]) => (
          <button key={t} role="tab" aria-selected={tab === t} className={tab === t ? "on" : ""} onClick={() => setSp({ tab: t })}>{l}</button>
        ))}
      </div>

      {tab === "design" && (
        <>
          <div className="grid g3">
            <div className="card">
              <h2>Design</h2>
              <p className="hint">{2 ** k} {k === 1 ? "settings" : "corners"} × {e.replicates}{e.center_points ? ` + ${e.center_points} middle points` : ""} = {e.runs.length} units · {pct(chance, 0)} chance to detect a {num(e.effect_size, 3)} {e.param_unit} change</p>
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
                    <td className="mono">{r.serial ?? <span className="muted">______</span>}</td>
                    <td>{r.asPlanned == null ? <span className="muted">☐ yes ☐ no</span> : r.asPlanned ? "yes" : "no"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
      {tab === "run" && <RunTab e={e} reload={reload} />}
      {tab === "analyze" && <AnalyzeTab e={e} busy={busy} simulate={() => run(() => post(`/api/experiments/${e.experiment_id}/simulate`), "analyze")} />}
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
          <p className="sub">Plan a designed experiment to see how one to three settings affect a measurement, run it on the line, and read the result.</p>
        </div>
        <Link to="/experiments/new" className="btn primary" style={{ textDecoration: "none" }}>+ New experiment</Link>
      </div>
      <div className="card">
        {list.data?.length === 0 ? (
          <div className="empty">No experiments yet. <Link to="/experiments/new">Design the first one</Link>.</div>
        ) : (
          <table>
            <thead><tr><th>ID</th><th>Name</th><th>Response</th><th className="num">Factors</th><th>Progress</th><th>Status</th><th>Created by</th><th>Created</th></tr></thead>
            <tbody>
              {(list.data ?? []).map((x) => (
                <tr key={x.experiment_id} className="clickable" onClick={() => nav(`/experiments/${x.experiment_id}${x.measured ? "?tab=analyze" : x.tagged ? "?tab=run" : ""}`)}>
                  <td>{eid4(x.experiment_id)}</td>
                  <td><Link to={`/experiments/${x.experiment_id}`}>{x.name}</Link></td>
                  <td>{x.response}</td><td className="num">{x.factors}</td>
                  <td><span className="minibar"><span style={{ width: `${(x.measured / x.runs) * 100}%` }} /></span> {x.measured}/{x.runs}</td>
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
