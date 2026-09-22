import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { BBox, dt, label, num, qs, Result, useApi } from "../lib";

type Unit = { serial: string; lot_id: string; tissue_lot: string; model: string; started_at: string; completed_at: string | null; status: string; first_pass: boolean | null; issues: number; last_step: number };
type Ev = {
  event_id: number; step_id: number; step_name: string; n_det: number | null; area: string; step_type: string; attempt: number; started_at: string; ended_at: string;
  operator_id: string; equipment_id: string; result: string; defect_code: string | null; param_name: string | null; param_unit: string | null;
  lsl: number | null; target: number | null; usl: number | null; value: number | null; has_image: number; true_class: string | null; ai_class: string | null;
  ai_confidence: number | null; bbox_x: number | null; bbox_y: number | null; bbox_w: number | null; bbox_h: number | null;
};
type Detail = Unit & { frame_lot: string; events: Ev[] };

function Status({ s }: { s: string }) {
  const m: Record<string, [string, string]> = { shipped: ["pass", "✓"], scrapped: ["scrap", "✕"], wip: ["", "…"] };
  return <span className={`pill ${m[s]?.[0] ?? ""}`}>{m[s]?.[1]} {s === "wip" ? "in process" : s}</span>;
}

function UnitDetail({ serial }: { serial: string }) {
  const { data: u, error } = useApi<Detail>(`/api/units/${serial}`);
  if (error) return <div className="empty">Unit {serial} not found.</div>;
  if (!u) return <div className="empty">Loading…</div>;
  const imgs = u.events.filter((e) => e.has_image);
  return (
    <>
      <p className="sub"><Link to="/units">← All units</Link></p>
      <h1>{u.serial} <Status s={u.status} /></h1>
      <p className="sub">{u.model} · build lot {u.lot_id} · tissue {u.tissue_lot} · wireform {u.frame_lot} · started {dt(u.started_at)}{u.completed_at ? ` · finished ${dt(u.completed_at)}` : ""}</p>

      {imgs.length > 0 && (
        <div className="card" style={{ marginBottom: 16 }}>
          <h2>Inspection images</h2>
          <p className="hint">Every visual step this unit has passed through</p>
          <div className="gallery">
            {imgs.map((e) => (
              <div className="shot" key={e.event_id} style={{ cursor: "default" }}>
                <div className="img"><img src={`/api/images/${e.event_id}.png`} alt={`${e.step_name}: ${label(e.true_class!)}`} loading="lazy" /><BBox b={e} /></div>
                <div className="meta"><b>{label(e.true_class!)}</b><span className="s">{e.step_id}. {e.step_name}{e.attempt > 1 ? ` (attempt ${e.attempt})` : ""}</span>
                  {e.ai_class !== e.true_class && <span className="pill rework">! AI: {label(e.ai_class!)}</span>}</div>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="card">
        <h2>Device history</h2>
        <p className="hint">{u.events.length} events across {new Set(u.events.map((e) => e.step_id)).size} of 50 steps</p>
        <div style={{ overflowX: "auto" }}>
          <table>
            <thead><tr><th>#</th><th>Step</th><th>Area</th><th>Result</th><th>Finding</th><th className="num">Measured</th><th>Spec</th><th>Operator</th><th>Station</th><th>Finished</th></tr></thead>
            <tbody>
              {u.events.map((e) => (
                <tr key={e.event_id}>
                  <td><Link to={`/flow?step=${e.step_id}`} title="Show this step in the process flow">{e.step_id}</Link>{e.attempt > 1 ? `·${e.attempt}` : ""}</td>
                  <td>{e.step_type === "measurement" ? <Link to={`/spc?step=${e.step_id}`}>{e.step_name}</Link> : e.step_name}</td>
                  <td>{e.area}</td>
                  <td><Result r={e.result} /></td>
                  <td>{e.defect_code ? label(e.defect_code) : ""}</td>
                  <td className="num">{e.value != null ? `${num(e.value, 3)} ${e.param_unit}` : ""}</td>
                  <td style={{ color: "var(--muted)" }}>{e.lsl != null ? `${e.lsl} – ${e.usl}` : ""}</td>
                  <td>{e.operator_id}</td><td>{e.equipment_id}</td><td>{dt(e.ended_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}

export default function Units() {
  const { serial } = useParams();
  const nav = useNavigate();
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("");
  const list = useApi<Unit[]>(serial ? null : `/api/units${qs({ search, status, limit: 200 })}`);
  if (serial) return <UnitDetail serial={serial} />;
  return (
    <>
      <h1>Unit genealogy</h1>
      <p className="sub">Full device history for any valve: every step, measurement, image, operator and station.</p>
      <div className="toolbar">
        <label>Serial<input type="text" placeholder="e.g. HV26" value={search} onChange={(e) => setSearch(e.target.value)} /></label>
        <label>Status
          <span className="seg">{[["", "All"], ["wip", "In process"], ["shipped", "Shipped"], ["scrapped", "Scrapped"]].map(([k, l]) => (
            <button key={k} className={status === k ? "on" : ""} onClick={() => setStatus(k)}>{l}</button>))}</span>
        </label>
      </div>
      <div className="card">
        <table>
          <thead><tr><th>Serial</th><th>Size</th><th>Build lot</th><th>Tissue lot</th><th>Status</th><th className="num">Issues</th><th className="num">Last step</th><th>Started</th></tr></thead>
          <tbody>
            {(list.data ?? []).map((u) => (
              <tr key={u.serial} className="clickable" onClick={() => nav(`/units/${u.serial}`)}>
                <td><Link to={`/units/${u.serial}`}>{u.serial}</Link></td><td>{u.model}</td><td>{u.lot_id}</td><td>{u.tissue_lot}</td>
                <td><Status s={u.status} /></td><td className="num">{u.issues || ""}</td><td className="num">{u.last_step}</td><td>{dt(u.started_at)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {list.data?.length === 0 && <div className="empty">No units match.</div>}
      </div>
    </>
  );
}
