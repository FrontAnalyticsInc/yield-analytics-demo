import { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { BBox, dt, label, num, pct, qs, Result, seq, useApi, useColors } from "../lib";

type Insp = {
  event_id: number; serial: string; step_id: number; step_name: string; attempt: number; ended_at: string;
  operator_id: string; equipment_id: string; result: string; lot_id: string; tissue_lot: string; model: string;
  true_class: string; ai_class: string; ai_confidence: number;
  bbox_x: number | null; bbox_y: number | null; bbox_w: number | null; bbox_h: number | null;
};
type Cell = { true_class: string; ai_class: string; n: number };
const VISUAL = [[1, "Pericardium receiving"], [10, "Leaflet visual"], [25, "Suture line"], [30, "Coaptation"], [44, "Final visual"]] as const;
const CLASSES = ["ok", "TISSUE_TEAR", "CALCIFIC_SPOT", "FIBER_PARTICLE", "SUTURE_GAP", "LEAFLET_MISALIGN"];
const PAGE = 60;

export function Shot({ i, big = false }: { i: Insp; big?: boolean }) {
  return (
    <div className="img">
      <img src={`/api/images/${i.event_id}.png`} alt={`${i.step_name} for ${i.serial}: ${label(i.true_class)}`} loading="lazy" />
      {(big || i.true_class !== "ok") && <BBox b={i} />}
    </div>
  );
}

function Verdict({ i }: { i: Insp }) {
  const agree = i.true_class === i.ai_class;
  return <span className={`pill ${agree ? "pass" : "rework"}`}>{agree ? "✓ AI agrees" : "! AI disagrees"}</span>;
}

export default function Inspections() {
  const c = useColors();
  const [sp, setSp] = useSearchParams();
  const step = sp.get("step") ?? "";
  const cls = sp.get("class") ?? "";
  const mismatch = sp.get("mismatch") === "1";
  const defectsOnly = sp.get("defects") !== "0";
  const set = (k: string, v: string) => { const n = new URLSearchParams(sp); v ? n.set(k, v) : n.delete(k); setSp(n, { replace: true }); };
  const [items, setItems] = useState<Insp[]>([]);
  const [offset, setOffset] = useState(0);
  const [open, setOpen] = useState<Insp | null>(null);
  const filt = qs({ step_id: step, true_class: cls, mismatch, defects_only: defectsOnly && !cls });
  const page = useApi<Insp[]>(`/api/inspections${filt}${filt ? "&" : "?"}limit=${PAGE}&offset=${offset}`);
  const cm = useApi<Cell[]>(`/api/inspections/confusion${qs({ step_id: step })}`);

  useEffect(() => { setItems([]); setOffset(0); }, [filt]);
  useEffect(() => { if (page.data) setItems((prev) => (offset === 0 ? page.data! : [...prev, ...page.data!])); }, [page.data]);  // eslint-disable-line
  useEffect(() => { const k = (e: KeyboardEvent) => e.key === "Escape" && setOpen(null); addEventListener("keydown", k); return () => removeEventListener("keydown", k); }, []);

  const cells = cm.data ?? [];
  const get = (t: string, a: string) => cells.find((x) => x.true_class === t && x.ai_class === a)?.n ?? 0;
  const total = cells.reduce((a, x) => a + x.n, 0);
  const agree = cells.filter((x) => x.true_class === x.ai_class).reduce((a, x) => a + x.n, 0);
  const rowMax = Math.max(1, ...cells.filter((x) => x.true_class !== "ok").map((x) => x.n));
  const truthDef = cells.filter((x) => x.true_class !== "ok").reduce((a, x) => a + x.n, 0);
  const missed = cells.filter((x) => x.true_class !== "ok" && x.ai_class === "ok").reduce((a, x) => a + x.n, 0);

  return (
    <>
      <h1>Image inspections</h1>
      <p className="sub">Five visual steps capture an image of every valve. Inspectors disposition each one; a vision model scores it in parallel.{step && <> <Link to={`/flow?step=${step}&view=caused`}>See what this check catches in the process flow →</Link></>}</p>
      <div className="toolbar">
        <label>Visual step
          <select value={step} onChange={(e) => set("step", e.target.value)}>
            <option value="">All visual steps</option>{VISUAL.map(([id, n]) => <option key={id} value={id}>{id}. {n}</option>)}
          </select>
        </label>
        <label>Inspector finding
          <select value={cls} onChange={(e) => set("class", e.target.value)}>
            <option value="">Any defect</option>{CLASSES.map((k) => <option key={k} value={k}>{label(k)}</option>)}
          </select>
        </label>
        <label className="check"><input type="checkbox" checked={mismatch} onChange={(e) => set("mismatch", e.target.checked ? "1" : "")} /> Only AI / inspector disagreements</label>
        {!cls && <label className="check"><input type="checkbox" checked={!defectsOnly} onChange={(e) => set("defects", e.target.checked ? "0" : "")} /> Include clean images</label>}
      </div>

      <div className="grid g3">
        <div className="card">
          <h2>Gallery</h2>
          <p className="hint">Newest first · yellow box marks the defect region · click for detail</p>
          {items.length === 0 ? <div className="empty">{page.loading ? "Loading…" : "No images match."}</div> : (
            <div className="gallery">
              {items.map((i) => (
                <button className="shot" key={i.event_id} onClick={() => setOpen(i)}>
                  <Shot i={i} />
                  <div className="meta">
                    <b>{label(i.true_class)}</b>
                    <span className="s">{i.serial} · step {i.step_id}</span>
                    {i.true_class !== i.ai_class && <span className="pill rework">! AI: {label(i.ai_class)}</span>}
                  </div>
                </button>
              ))}
            </div>
          )}
          {page.data?.length === PAGE && <div style={{ textAlign: "center", marginTop: 14 }}><button className="btn" onClick={() => setOffset(offset + PAGE)}>Load more</button></div>}
        </div>

        <div className="card">
          <h2>Vision model vs inspector</h2>
          <p className="hint">{pct(total ? agree / total : null)} agreement on {num(total)} images · model missed {num(missed)} of {num(truthDef)} real defects</p>
          <div style={{ overflowX: "auto" }}>
            <table className="cm">
              <thead><tr><th>Inspector ↓ / AI →</th>{CLASSES.map((k) => <th key={k} title={label(k)}>{k === "ok" ? "OK" : k.split("_").map((w) => w[0]).join("")}</th>)}</tr></thead>
              <tbody>
                {CLASSES.map((t) => (
                  <tr key={t}><th style={{ whiteSpace: "nowrap" }}>{label(t)}</th>
                    {CLASSES.map((a) => {
                      const n = get(t, a);
                      const heat = t === "ok" && a === "ok" ? 0 : n / rowMax;
                      return <td key={a} title={`${label(t)} → AI ${label(a)}: ${n}`} style={{ background: n ? seq(heat, c.seqLo, c.seqHi) : undefined, color: heat > 0.55 ? "#fff" : undefined, cursor: n ? "pointer" : undefined }}
                        onClick={() => { if (!n) return; const q = new URLSearchParams(sp); t === "ok" ? q.delete("class") : q.set("class", t); q.set("mismatch", t !== a ? "1" : ""); if (t === "ok") q.set("defects", "0"); setSp(q, { replace: true }); }}>{n || ""}</td>;
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="hint" style={{ marginTop: 10 }}>Diagonal = agreement. Column initials: TT tear, CS calcific spot, FP fiber/particle, SG suture gap, LM leaflet misalign.</p>
        </div>
      </div>

      {open && (
        <div className="modal-bg" onClick={() => setOpen(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Inspection detail">
            <Shot i={open} big />
            <div className="info">
              <h2>{label(open.true_class)}</h2>
              <Verdict i={open} />
              <dl>
                <dt>Unit</dt><dd><Link to={`/units/${open.serial}`}>{open.serial}</Link></dd>
                <dt>Step</dt><dd>{open.step_id}. {open.step_name}</dd>
                <dt>Attempt</dt><dd>{open.attempt}</dd>
                <dt>Result</dt><dd><Result r={open.result} /></dd>
                <dt>AI call</dt><dd>{label(open.ai_class)} ({pct(open.ai_confidence, 0)})</dd>
                <dt>Operator</dt><dd>{open.operator_id}</dd>
                <dt>Station</dt><dd>{open.equipment_id}</dd>
                <dt>Tissue lot</dt><dd>{open.tissue_lot}</dd>
                <dt>Size</dt><dd>{open.model}</dd>
                <dt>When</dt><dd>{dt(open.ended_at)}</dd>
              </dl>
              <button className="btn" onClick={() => setOpen(null)}>Close</button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
