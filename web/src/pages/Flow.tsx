import { Fragment, useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { PeriodBar, useFilters } from "../main";
import { label, num, pct, qs, useApi, useColors } from "../lib";

type Counts = Record<string, number>;
type Step = {
  step_id: number; name: string; area: string; step_type: "process" | "measurement" | "visual" | "gate" | "scan";
  param_unit: string | null; entered: number; fpy: number; first_fail: number;
  scrap: Counts; rework: Counts; caused_scrap: Counts; caused_rework: Counts;
  cpk: number | null; ai_agreement: number | null; images: number;
};
type Resp = { units: number; shipped: number; yield: number | null; rty: number; steps: Step[] };

/** flow column width, band centre and band width at 100% of the cohort; narrower on phones */
const WIDE = { W: 230, CX: 78, BAND: 60 }, NARROW = { W: 120, CX: 40, BAND: 36 };
function useNarrow() {
  const mq = "(max-width: 700px)";
  const [n, setN] = useState(() => matchMedia(mq).matches);
  useEffect(() => { const m = matchMedia(mq); const on = () => setN(m.matches); m.addEventListener("change", on); return () => m.removeEventListener("change", on); }, []);
  return n;
}
const MAG = 10;         // fallout ribbons drawn this many times their true width
const ROW = 30, GATE = 36, OPEN = 176, AREA = 24;
const MAG_RW = 3;       // rework loops are thinner so ten loops don't swamp four exits
const MAX_RW = 13;      // ... and capped, so one heavy-rework gate stays a loop and not a blob
const MAX_SC = 26;      // a gate that scraps a quarter of the line would otherwise draw a 130px slab
const MAX_TH = 9;       // attribution threads run the length of the page, so they stay thin
const sum = (c: Counts) => Object.values(c).reduce((a, b) => a + b, 0);
const isGate = (s: Step) => s.step_type !== "process";
/** caused-view keys are "DEFECT@catchStep" */
const split = (k: string) => { const [d, at] = k.split("@"); return { defect: d, at: +at }; };

export default function Flow() {
  const f = useFilters();
  const c = useColors();
  const { W, CX, BAND } = useNarrow() ? NARROW : WIDE;
  const [sp, setSp] = useSearchParams();
  const view = sp.get("view") === "caused" ? "caused" : "caught";
  const sel = Number(sp.get("step")) || null;
  const set = (k: string, v: string) => { const n = new URLSearchParams(sp); v ? n.set(k, v) : n.delete(k); setSp(n, { replace: true }); };
  const meta = useApi<{ models: string[] }>("/api/meta");
  const r = useApi<Resp>(`/api/flow${qs({ start: f.start, model: f.model })}`);
  const d = r.data;
  const steps = d?.steps ?? [];
  const units = d?.units || 1;
  const bw = (n: number) => (BAND * n) / units;

  // vertical layout: gate rows are taller, the selected row opens a detail panel
  const ys: number[] = [];
  let y = 8;
  steps.forEach((s, i) => { if (i === 0 || steps[i - 1].area !== s.area) y += AREA; ys.push(y); y += (isGate(s) ? GATE : ROW) + (s.step_id === sel ? OPEN : 0); });
  const H = y + 8;
  const mid = (i: number) => ys[i] + (isGate(steps[i]) ? GATE : ROW) / 2;
  const idx = (id: number) => id - 1;

  // runs of process steps with no measurement or image between two gates
  const blind: { from: number; to: number }[] = [];
  steps.forEach((s, i) => {
    if (isGate(s)) return;
    const last = blind[blind.length - 1];
    if (last && last.to === i - 1) last.to = i; else blind.push({ from: i, to: i });
  });

  // scrap threads in caused view: start at the causing step, travel inside the band, leave where caught
  const threads = view === "caused" ? steps.flatMap((s) => Object.entries(s.caused_scrap).map(([k, n]) => ({ from: s.step_id, ...split(k), n }))) : [];

  return (
    <>
      <h1>Process flow</h1>
      <p className="sub">
        All {steps.length || 53} routing steps, top to bottom. The band is the units still in the process. Units that were scrapped leave to the right, and
        rework loops back on the left. Most steps have no measurement, so a defect made there only shows up at a later check.
      </p>
      <div className="toolbar">
        <label>Show fallout at
          <span className="seg">
            <button className={view === "caught" ? "on" : ""} onClick={() => set("view", "")}>Where it was caught</button>
            <button className={view === "caused" ? "on" : ""} onClick={() => set("view", "caused")}>Where it was likely caused</button>
          </span>
        </label>
        <PeriodBar models={meta.data?.models} />
      </div>

      <div className="tiles">
        <div className="tile"><div className="k">Units finished</div><div className="v">{num(d?.units)}</div><div className="d">shipped or scrapped in the period</div></div>
        <div className="tile"><div className="k">Shipped</div><div className="v">{num(d?.shipped)}</div><div className="d">final yield {pct(d?.yield)}</div></div>
        <div className="tile"><div className="k">Rolled throughput yield</div><div className="v">{pct(d?.rty)}</div><div className="d">through every step first time</div></div>
        <div className="tile"><div className="k">Checks</div><div className="v">{steps.filter(isGate).length} <span style={{ fontSize: 15, color: "var(--muted)" }}>of {steps.length || 53}</span></div><div className="d">steps that measure, image or gate the valve</div></div>
      </div>

      <div className="card">
        <div className="legend">
          <span><i className="sw" style={{ background: c.s1, opacity: 0.35, height: 10 }} />Units in process</span>
          <span><i className="sw" style={{ background: c.critical }} />Scrapped ({MAG}× width)</span>
          <span><i className="sw" style={{ background: "var(--warning)" }} />Reworked ({MAG_RW}× width)</span>
          <span><i className="sw" style={{ background: c.grid, height: 10 }} />No check (blind stretch)</span>
          {view === "caused" && <span><i className="sw" style={{ borderTop: `2px dashed ${c.critical}`, background: "none" }} />Undetected defect, carried to the check that found it</span>}
        </div>
        {view === "caused" && (
          <p className="hint">Causes are engineering's attribution of each defect to the step that most likely produced it. They are assumptions, not
            measurements. The scrap is still counted where it was caught.</p>
        )}
        {r.error && <p className="hint">Could not load: {r.error}</p>}

        <div className="flow" style={{ height: H }}>
          <svg className="flowsvg" width={W} height={H} aria-label="Units flowing through the routing, top to bottom">
            {blind.map((b) => (
              <g key={b.from}>
                <rect x={4} y={ys[b.from] + 2} width={W - 8} height={ys[b.to] + ROW - ys[b.from] - 4 + (steps[b.to].step_id === sel ? OPEN : 0)} rx={6} fill={c.grid} opacity={0.45} />
                {b.to - b.from >= 2 && W > 200 && <text x={8} y={ys[b.from] + 14} fontSize={10.5} fill={c.muted}>{b.to - b.from + 1} steps unchecked</text>}
              </g>
            ))}
            {/* the band: a trapezoid per step so it narrows exactly where units leave */}
            {steps.map((s, i) => {
              const top = bw(s.entered), bot = bw(s.entered - sum(s.scrap));
              const h = ys[i + 1] !== undefined ? ys[i + 1] - ys[i] : (isGate(s) ? GATE : ROW);
              return <path key={s.step_id} fill={c.s1} opacity={0.35}
                d={`M${CX - top / 2},${ys[i]} L${CX + top / 2},${ys[i]} L${CX + bot / 2},${ys[i] + h} L${CX - bot / 2},${ys[i] + h}Z`} />;
            })}
            {steps.map((s, i) => isGate(s) && (
              <rect key={s.step_id} x={CX - 7} y={mid(i) - 7} width={14} height={14} transform={`rotate(45 ${CX} ${mid(i)})`}
                fill={c.surface} stroke={c.s1} strokeWidth={2} />
            ))}
            {/* rework: a loop back on the left, width by count */}
            {steps.map((s, i) => {
              const n = sum(view === "caused" ? s.caused_rework : s.rework);
              if (!n) return null;
              const x = CX - bw(s.entered) / 2 - 2, m = mid(i);
              return <path key={s.step_id} fill="none" stroke="var(--warning)" strokeWidth={Math.min(MAX_RW, Math.max(1.5, bw(n) * MAG_RW))} strokeLinecap="round" opacity={0.9}
                d={`M${x},${m + 6} C${x - 26},${m + 10} ${x - 26},${m - 12} ${x},${m - 8}`}><title>{`${n} reworked at step ${s.step_id}`}</title></path>;
            })}
            {/* scrap leaving on the right */}
            {view === "caught" && steps.map((s, i) => {
              const n = sum(s.scrap);
              if (!n) return null;
              const x = CX + bw(s.entered) / 2, m = mid(i);
              return (
                <g key={s.step_id}>
                  <path fill="none" stroke={c.critical} strokeWidth={Math.min(MAX_SC, Math.max(2, bw(n) * MAG))} opacity={0.85}
                    d={`M${x - 2},${m} C${x + 40},${m} ${x + 40},${m + 16} ${W - 44},${m + 16}`}><title>{`${n} scrapped at step ${s.step_id}`}</title></path>
                  <text x={W - 40} y={m + 20} fontSize={12} fontWeight={650} fill={c.critical}>{n}</text>
                </g>
              );
            })}
            {threads.map((t, k) => {
              const a = mid(idx(t.from)), b = mid(idx(t.at));
              const x = CX + 6 + (k % 4) * 6;
              const w = Math.min(MAX_TH, Math.max(2, bw(t.n) * MAG));
              return (
                <g key={k}>
                  <circle cx={x} cy={a} r={4} fill={c.critical} />
                  <path fill="none" stroke={c.critical} strokeWidth={w} strokeDasharray={t.from === t.at ? undefined : "6 5"} opacity={0.7}
                    d={`M${x},${a} L${x},${b} C${x + 40},${b} ${x + 40},${b + 16} ${W - 44},${b + 16}`}>
                    <title>{`${t.n} × ${label(t.defect)}: likely caused at step ${t.from}, caught at step ${t.at}`}</title>
                  </path>
                  <text x={W - 40} y={b + 20 + (k % 2) * 12} fontSize={11.5} fontWeight={650} fill={c.critical}>{t.n}</text>
                </g>
              );
            })}
          </svg>

          {steps.map((s, i) => (
            <Fragment key={s.step_id}>
              {(i === 0 || steps[i - 1].area !== s.area) && <div className="flowarea" style={{ top: ys[i] - AREA, height: AREA, left: W }}>{s.area}</div>}
              <Row s={s} left={W} top={ys[i]} open={s.step_id === sel} view={view} units={units}
                onClick={() => set("step", s.step_id === sel ? "" : String(s.step_id))} />
            </Fragment>
          ))}
        </div>
      </div>
    </>
  );
}

function Row({ s, left, top, open, view, units, onClick }: { s: Step; left: number; top: number; open: boolean; view: string; units: number; onClick: () => void }) {
  const scrap = sum(view === "caused" ? s.caused_scrap : s.scrap);
  const rework = sum(view === "caused" ? s.caused_rework : s.rework);
  const gate = s.step_type !== "process";
  return (
    <div className={`flowrow${gate ? " gate" : ""}${open ? " open" : ""}`} style={{ left, top, height: (gate ? GATE : ROW) + (open ? OPEN : 0) }}>
      <button className="flowhead" onClick={onClick} aria-expanded={open} style={{ height: gate ? GATE : ROW }}>
        <span className="no">{s.step_id}</span>
        <span className="nm">{s.name}</span>
        <span className="ty">{{ measurement: "measure", visual: "image", scan: "scan", gate: "go / no-go", process: "" }[s.step_type]}</span>
        <span className="num">{num(s.entered)}</span>
        <span className={`num ${s.fpy < 0.97 ? "bad" : ""}`}>{gate || s.first_fail ? pct(s.fpy) : ""}</span>
        <span className="num rw">{rework ? `↻ ${rework}` : ""}</span>
        <span className="num sc">{scrap ? `✕ ${scrap}` : ""}</span>
        <span className="gm">
          {s.cpk != null && <span className={`pill ${s.cpk >= 1.33 ? "pass" : s.cpk >= 1 ? "rework" : "scrap"}`}>Cpk {num(s.cpk, 2)}</span>}
          {s.ai_agreement != null && <span className="pill">AI {pct(s.ai_agreement, 0)}</span>}
        </span>
      </button>
      {open && <Detail s={s} view={view} units={units} />}
    </div>
  );
}

function Detail({ s, view, units }: { s: Step; view: string; units: number }) {
  const caught = [...Object.entries(s.scrap).map(([k, n]) => ({ k, n, r: "scrap" })), ...Object.entries(s.rework).map(([k, n]) => ({ k, n, r: "rework" }))];
  const caused = [...Object.entries(s.caused_scrap).map(([k, n]) => ({ ...split(k), n, r: "scrap" })), ...Object.entries(s.caused_rework).map(([k, n]) => ({ ...split(k), n, r: "rework" }))]
    .filter((x) => x.at !== s.step_id);
  return (
    <div className="flowdetail">
      <div>
        <h3>Caught here</h3>
        {caught.length ? caught.sort((a, b) => b.n - a.n).map((x) => (
          <div key={x.r + x.k} className="fd">
            <span className={`pill ${x.r}`}>{x.r === "scrap" ? "✕" : "↻"} {x.n}</span>
            {(s.step_type === "visual" || s.step_type === "scan") && x.k !== "PROCESS_DEV"
              ? <Link to={`/inspections${qs({ step: s.step_id, class: x.k })}`}>{label(x.k)} images →</Link>
              : <span>{label(x.k)}</span>}
          </div>
        )) : <p className="muted">Nothing. {num(s.entered)} of {num(units)} units passed first time.</p>}
      </div>
      <div>
        <h3>Likely caused here, found later</h3>
        {caused.length ? caused.sort((a, b) => b.n - a.n).map((x) => (
          <div key={x.r + x.defect + x.at} className="fd">
            <span className={`pill ${x.r}`}>{x.r === "scrap" ? "✕" : "↻"} {x.n}</span>
            <span>{label(x.defect)}, found at <Link to={`/flow?step=${x.at}${view === "caused" ? "&view=caused" : ""}`}>step {x.at}</Link> ({x.at - s.step_id} {x.at - s.step_id === 1 ? "step" : "steps"} later)</span>
          </div>
        )) : <p className="muted">No later fallout is attributed to this step.</p>}
      </div>
      <div className="fdlinks">
        <h3>Dig in</h3>
        {s.step_type === "measurement" && <Link to={`/spc?step=${s.step_id}`}>SPC chart and capability →</Link>}
        {(s.step_type === "visual" || s.step_type === "scan") && <Link to={`/inspections?step=${s.step_id}`}>All {s.step_type === "scan" ? "scans" : "inspection images"} ({num(s.images)}) →</Link>}
        <Link to={`/explore?step=${s.step_id}`}>Fail rate by operator, station and lot →</Link>
      </div>
    </div>
  );
}
