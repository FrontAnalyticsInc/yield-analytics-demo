import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import DesignDiagram from "../DesignDiagram";
import {
  buildRuns, centerRule, cornerRunsNeeded, detectionChance, Factor, recommendedReplicates, settingLabel, validateFactors,
} from "../doe";
import { num, pct, useApi } from "../lib";

type Step = { step_id: number; name: string; step_type: string; param_name: string; param_unit: string; lsl: number; target: number; usl: number };
type Noise = { n: number; mean: number | null; sd: number | null; days: number };
type Operator = { operator_id: string; name: string };

const CONFIDENCE = {
  standard: { label: "Standard", alpha: 0.05, power: 0.8, hint: "95% confidence · 80% chance to detect" },
  strict: { label: "Strict", alpha: 0.05, power: 0.9, hint: "95% confidence · 90% chance to detect" },
} as const;

const blankFactor = (): Factor => ({ name: "", kind: "numeric", units: "", low: 0, high: 1, lowLabel: "A", highLabel: "B" });

const EXAMPLE: Factor[] = [
  { name: "Suture tension setting", kind: "numeric", units: "N", low: 1.8, high: 2.4, lowLabel: "A", highLabel: "B" },
  { name: "Fixation time", kind: "numeric", units: "h", low: 20, high: 28, lowLabel: "A", highLabel: "B" },
];

function NumberInput({ value, onChange, step = "any", width = 90 }: { value: number; onChange: (v: number) => void; step?: string; width?: number }) {
  const [text, setText] = useState(String(value));
  useEffect(() => { if (parseFloat(text) !== value) setText(String(value)); }, [value]); // eslint-disable-line
  return <input type="number" step={step} value={text} style={{ width, minWidth: 0 }}
    onChange={(e) => { setText(e.target.value); const v = parseFloat(e.target.value); if (!Number.isNaN(v)) onChange(v); }} />;
}

/** Is the gap between this factor's low and high settings big enough to show up? */
function ExpectedCheck({ f, sigma, effect, alpha, cornerN, unit }: { f: Factor; sigma: number; effect: number; alpha: number; cornerN: number; unit: string }) {
  if (f.expected == null || !(sigma > 0)) return null;
  const exp = Math.abs(f.expected);
  const chance = detectionChance(sigma, exp, alpha, cornerN);
  const ok = chance >= 0.8;
  let advice = "";
  if (!ok && exp > 0 && f.kind === "numeric") {
    // assuming a straight-line response, widen the range around its middle
    const half = ((f.high - f.low) / 2) * (effect / exp);
    const mid = (f.low + f.high) / 2;
    advice = ` To expect a ${+effect.toPrecision(3)} ${unit} change, try about ${+(mid - half).toPrecision(4)} – ${+(mid + half).toPrecision(4)} ${f.units} if that's safe to run, or add repeats.`;
  } else if (!ok) {
    advice = " Add repeats, or pick two values that differ more.";
  }
  return (
    <span className="hint" style={{ maxWidth: 360 }}>
      <span className={`pill ${ok ? "pass" : chance >= 0.5 ? "rework" : "scrap"}`}>{ok ? "✓" : "!"} {pct(chance, 0)} chance to see it</span>
      {exp < effect && <> This gap is smaller than the {+effect.toPrecision(3)} {unit} you care about.</>}{advice}
    </span>
  );
}

export default function DoeDesign() {
  const nav = useNavigate();
  const meta = useApi<{ steps: Step[]; operators: Operator[] }>("/api/meta");
  const mSteps = (meta.data?.steps ?? []).filter((s) => s.step_type === "measurement");

  // 1. response — resolved by name once the step list loads, because step ids move
  // when the route changes and a stale id lands on a step that has no measurements
  const [stepId, setStepId] = useState<number | null>(null);
  useEffect(() => {
    if (!mSteps.length) return;
    if (stepId && mSteps.some((s) => s.step_id === stepId)) return;
    const pick = mSteps.find((s) => s.name === "Commissure height measurement") ?? mSteps[0];
    setStepId(pick.step_id);
  }, [meta.data, stepId]);  // eslint-disable-line
  const noise = useApi<Noise>(stepId ? `/api/doe/noise/${stepId}` : null);
  const step = mSteps.find((s) => s.step_id === stepId);
  const [sigmaOverride, setSigmaOverride] = useState<number | null>(null);
  const sigma = sigmaOverride ?? noise.data?.sd ?? 0;
  const [effect, setEffect] = useState<number | null>(null);
  const specWidth = step ? step.usl - step.lsl : 0;
  const effectSize = effect ?? (sigma > 0 ? +(1.5 * sigma).toPrecision(2) : 0);  // default: a shift of 1.5σ
  useEffect(() => { setSigmaOverride(null); setEffect(null); }, [stepId]);

  // 2. factors
  const [factors, setFactors] = useState<Factor[]>(EXAMPLE);
  const setF = (i: number, patch: Partial<Factor>) => setFactors((fs) => fs.map((f, j) => (j === i ? { ...f, ...patch } : f)));
  const errs = validateFactors(factors);
  const k = factors.length;

  // 3. plan
  const [conf, setConf] = useState<keyof typeof CONFIDENCE>("standard");
  const { alpha, power } = CONFIDENCE[conf];
  const recReps = recommendedReplicates(k, sigma, effectSize, alpha, power);
  const [repOverride, setRepOverride] = useState<number | null>(null);
  const reps = repOverride ?? recReps;
  const rule = centerRule(factors);
  const [cpOverride, setCpOverride] = useState<number | null>(null);
  const perCombo = rule.applicable ? cpOverride ?? rule.defaultPerCombo : 0;
  useEffect(() => { setCpOverride(null); }, [rule.combos]);
  const [seed, setSeed] = useState(() => Math.floor(Math.random() * 1e9));

  const runs = useMemo(() => (errs.length ? [] : buildRuns(factors, reps, perCombo, seed)), [factors, reps, perCombo, seed, errs.length]);
  const cornerN = reps * 2 ** k;
  const chance = detectionChance(sigma, effectSize, alpha, cornerN);
  const needed = sigma > 0 && effectSize > 0 ? cornerRunsNeeded(sigma, effectSize, alpha, power) : 0;
  const centers = runs.filter((r) => r.pointType === "center").length;

  // 4. save
  const [name, setName] = useState("");
  const [objective, setObjective] = useState("");
  const [notes, setNotes] = useState("");
  const [operator, setOperator] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveErr, setSaveErr] = useState<string | null>(null);
  const canSave = !errs.length && sigma > 0 && effectSize > 0 && name.trim() && operator && !saving;

  async function save() {
    setSaving(true); setSaveErr(null);
    try {
      const r = await fetch("/api/experiments", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: name.trim(), objective, notes, created_by: operator, response_step_id: stepId, sigma, effect_size: effectSize,
          alpha, power_target: power, replicates: reps, center_points: centers, seed,
          factors: factors.map((f) => ({ ...f, name: f.name.trim(), lowLabel: f.lowLabel.trim(), highLabel: f.highLabel.trim() })), runs,
        }),
      });
      if (!r.ok) throw new Error((await r.json().catch(() => null))?.detail ?? r.statusText);
      nav(`/experiments/${(await r.json()).experiment_id}`);
    } catch (e) {
      setSaveErr(typeof e === "object" && e && "message" in e ? String((e as Error).message) : String(e));
      setSaving(false);
    }
  }

  const u = step?.param_unit ?? "";
  return (
    <>
      <h1>New experiment</h1>
      <p className="sub">Choose what to measure and which settings to change. The calculator works out how many units to run at each setting and in what order.</p>

      <div className="doe">
        <div className="doe-form">
          <section className="card">
            <h2><span className="stepno">1</span>What are you measuring?</h2>
            <label className="field">Response (measurement step)
              <select value={stepId ?? ""} onChange={(e) => setStepId(+e.target.value)}>
                {mSteps.map((s) => <option key={s.step_id} value={s.step_id}>{s.step_id}. {s.name} ({s.param_unit})</option>)}
              </select>
            </label>
            {step && <p className="hint">Spec {step.lsl} – {step.usl} {u} · target {step.target} {u}</p>}
            <div className="row2">
              <label className="field">Process noise σ ({u})
                <NumberInput value={+sigma.toPrecision(3)} onChange={(v) => setSigmaOverride(v)} />
                <span className="hint">{sigmaOverride != null ? <>Overridden · <button className="linkbtn" onClick={() => setSigmaOverride(null)}>use line data</button></>
                  : noise.data?.sd ? `From ${num(noise.data.n)} units, last ${noise.data.days} days` : "Loading line data…"}</span>
              </label>
              <label className="field">Smallest change that matters ({u})
                <NumberInput value={effectSize} onChange={(v) => setEffect(v)} />
                <span className="hint">{specWidth ? `${pct(effectSize / specWidth, 0)} of the spec width · ${num(effectSize / (sigma || 1), 1)}× the noise` : ""}</span>
              </label>
            </div>
          </section>

          <section className="card">
            <h2><span className="stepno">2</span>Which settings will you change?</h2>
            <p className="hint">One to three factors, each at a low and a high setting. One factor is a simple low-vs-high comparison; two or three also show whether settings interact. Categorical factors are things like a station or a material lot.</p>
            {factors.map((f, i) => (
              <div className="factor" key={i}>
                <div className="factor-head">
                  <span className="fno">{String.fromCharCode(65 + i)}</span>
                  <input type="text" placeholder="Factor name" value={f.name} onChange={(e) => setF(i, { name: e.target.value })} style={{ flex: 1 }} />
                  <span className="seg">
                    <button className={f.kind === "numeric" ? "on" : ""} onClick={() => setF(i, { kind: "numeric" })}>Numeric</button>
                    <button className={f.kind === "categorical" ? "on" : ""} onClick={() => setF(i, { kind: "categorical" })}>Categorical</button>
                  </span>
                  {k > 1 && <button className="linkbtn" aria-label={`Remove factor ${i + 1}`} onClick={() => setFactors(factors.filter((_, j) => j !== i))}>Remove</button>}
                </div>
                {f.kind === "numeric" ? (
                  <div className="factor-levels">
                    <label>Low<NumberInput value={f.low} onChange={(v) => setF(i, { low: v })} /></label>
                    <label>High<NumberInput value={f.high} onChange={(v) => setF(i, { high: v })} /></label>
                    <label>Units<input type="text" value={f.units} onChange={(e) => setF(i, { units: e.target.value })} style={{ width: 70, minWidth: 0 }} /></label>
                    <span className="hint">Middle {settingLabel(f, 0)}</span>
                  </div>
                ) : (
                  <div className="factor-levels">
                    <label>Value 1<input type="text" value={f.lowLabel} onChange={(e) => setF(i, { lowLabel: e.target.value })} style={{ width: 130, minWidth: 0 }} /></label>
                    <label>Value 2<input type="text" value={f.highLabel} onChange={(e) => setF(i, { highLabel: e.target.value })} style={{ width: 130, minWidth: 0 }} /></label>
                  </div>
                )}
                <div className="factor-levels">
                  <label title="Your best guess of how much the response moves between the low and high setting">Expected change, low → high ({u})
                    <input type="number" step="any" placeholder="optional" value={f.expected ?? ""} style={{ width: 110, minWidth: 0 }}
                      onChange={(e) => { const v = parseFloat(e.target.value); setF(i, { expected: Number.isNaN(v) ? null : v }); }} />
                  </label>
                  <ExpectedCheck f={f} sigma={sigma} effect={effectSize} alpha={alpha} cornerN={cornerN} unit={u} />
                </div>
              </div>
            ))}
            {k < 3 && <button className="btn" onClick={() => setFactors([...factors, blankFactor()])}>+ Add {k === 1 ? "a second" : "a third"} factor</button>}
            {errs.length > 0 && <ul className="errs">{errs.map((e) => <li key={e}>{e}</li>)}</ul>}
          </section>

          <section className="card">
            <h2><span className="stepno">3</span>How sure do you need to be?</h2>
            <div className="seg" style={{ marginBottom: 6 }}>
              {(Object.keys(CONFIDENCE) as (keyof typeof CONFIDENCE)[]).map((c) => (
                <button key={c} className={conf === c ? "on" : ""} onClick={() => setConf(c)}>{CONFIDENCE[c].label}</button>
              ))}
            </div>
            <p className="hint">{CONFIDENCE[conf].hint}</p>
            <div className="row2">
              <label className="field">Repeats of each {k === 1 ? "setting" : "corner"}: <b>{reps}</b> {repOverride == null ? "(recommended)" : <button className="linkbtn" onClick={() => setRepOverride(null)}>reset to {recReps}</button>}
                <input type="range" min={1} max={Math.max(8, recReps + 2)} value={reps} onChange={(e) => setRepOverride(+e.target.value)} />
                <span className="hint">{2 ** k} {k === 1 ? "settings" : "corners"} × {reps} = {cornerN} runs · needs about {Math.ceil(needed)} to hit {pct(power, 0)}</span>
              </label>
              <label className="field">Middle (centre) points: <b>{rule.applicable ? perCombo * rule.combos : 0}</b>
                {rule.applicable ? (
                  <input type="range" min={0} max={rule.combos === 1 ? 5 : 3} value={perCombo} onChange={(e) => setCpOverride(+e.target.value)} />
                ) : null}
                <span className="hint">{rule.applicable && rule.combos > 1 ? `${perCombo} at each of ${rule.combos} categorical combinations. ` : ""}{rule.note}
                  {rule.applicable && perCombo === 0 ? " Without them there's no curvature or drift check." : ""}</span>
              </label>
            </div>
          </section>
        </div>

        <div className="doe-result">
          <section className="card">
            <div className="headline">
              <div><div className="big">{errs.length ? "—" : runs.length}</div><div className="hint">units in total</div></div>
              <div><div className="big" style={{ color: chance >= power - 0.005 ? "var(--good-text)" : chance >= 0.6 ? "#b07500" : "var(--critical)" }}>{errs.length ? "—" : pct(chance, 0)}</div><div className="hint">chance to detect a {num(effectSize, 3)} {u} change</div></div>
            </div>
            {!errs.length && (
              <p className="verdict">
                Run <b>{2 ** k} {k === 1 ? "settings" : "corners"} × {reps}</b>{centers ? <> plus <b>{centers} middle point{centers > 1 ? "s" : ""}</b></> : null}.
                {chance >= power - 0.005 ? " That meets the target." : ` That is below the ${pct(power, 0)} target; add repeats or accept a larger change.`}
              </p>
            )}
            {!errs.length && <DesignDiagram factors={factors} runs={runs} />}
            <div className="legend" style={{ marginTop: 8 }}>
              <span><i style={{ width: 10, height: 10, borderRadius: 5, background: "var(--accent)", display: "inline-block" }} />Corner run</span>
              <span><i style={{ width: 9, height: 9, background: "var(--series-2)", transform: "rotate(45deg)", display: "inline-block" }} />Middle point</span>
              <span>×n = units at that setting · hover for run numbers</span>
            </div>
          </section>

          <section className="card">
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
              <h2>Run sheet</h2>
              <button className="btn" onClick={() => setSeed(Math.floor(Math.random() * 1e9))}>Shuffle order</button>
            </div>
            <p className="hint">Randomised order; middle points are fixed at the start, middle and end to check for drift.</p>
            <div style={{ maxHeight: 320, overflow: "auto" }}>
              <table>
                <thead><tr><th>Run</th><th>Type</th>{factors.map((f, i) => <th key={i}>{f.name || `Factor ${i + 1}`}</th>)}</tr></thead>
                <tbody>
                  {runs.map((r) => (
                    <tr key={r.runNo}>
                      <td>{r.runNo}</td>
                      <td>{r.pointType === "center" ? <span className="pill" style={{ color: "var(--series-2)" }}>◆ middle</span> : "corner"}</td>
                      {factors.map((f, i) => <td key={i}>{settingLabel(f, r.x[i])}</td>)}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          <section className="card">
            <h2><span className="stepno">4</span>Save the experiment</h2>
            <label className="field">Name<input type="text" value={name} placeholder="e.g. Commissure height vs tension and fixation" onChange={(e) => setName(e.target.value)} /></label>
            <label className="field">Objective<input type="text" value={objective} placeholder="What question should this answer?" onChange={(e) => setObjective(e.target.value)} /></label>
            <label className="field">Operator
              <select value={operator} onChange={(e) => setOperator(e.target.value)}>
                <option value="">Select…</option>
                {(meta.data?.operators ?? []).map((o) => <option key={o.operator_id} value={o.operator_id}>{o.name} ({o.operator_id})</option>)}
              </select>
            </label>
            <label className="field">Notes<textarea rows={3} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Materials, equipment, anything the team should know" /></label>
            {saveErr && <ul className="errs"><li>{saveErr}</li></ul>}
            <button className="btn primary" disabled={!canSave} onClick={save}>{saving ? "Saving…" : "Save experiment"}</button>
            {!canSave && !saving && <span className="hint" style={{ marginLeft: 10 }}>{!name.trim() ? "Add a name" : !operator ? "Pick an operator" : errs.length ? "Fix the factors above" : ""}</span>}
          </section>
        </div>
      </div>
    </>
  );
}
