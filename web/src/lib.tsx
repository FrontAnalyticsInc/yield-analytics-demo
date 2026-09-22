import { useEffect, useState } from "react";

export function useApi<T>(path: string | null): { data: T | null; loading: boolean; error: string | null } {
  const [state, setState] = useState<{ data: T | null; loading: boolean; error: string | null }>({
    data: null, loading: !!path, error: null,
  });
  useEffect(() => {
    if (!path) return;
    let live = true;
    setState((s) => ({ ...s, loading: true }));
    fetch(path)
      .then((r) => (r.ok ? r.json() : Promise.reject(`${r.status} ${r.statusText}`)))
      .then((data) => live && setState({ data, loading: false, error: null }))
      .catch((e) => live && setState({ data: null, loading: false, error: String(e) }));
    return () => { live = false; };
  }, [path]);
  return state;
}

export function qs(params: Record<string, string | number | boolean | null | undefined>) {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== null && v !== undefined && v !== "" && v !== false) p.set(k, String(v));
  const s = p.toString();
  return s ? `?${s}` : "";
}

export const pct = (v: number | null | undefined, d = 1) => (v == null ? "—" : `${(v * 100).toFixed(d)}%`);
export const num = (v: number | null | undefined, d = 0) => (v == null ? "—" : v.toLocaleString(undefined, { maximumFractionDigits: d, minimumFractionDigits: d }));
export const day = (s: string) => new Date(s).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "2-digit" });
export const dt = (s: string) => new Date(s).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
export const label = (code: string) =>
  code === "ok" ? "OK" : code.startsWith("OOS_") ? `Out of spec (${code.slice(4).toLowerCase()})`
    : code.replace(/_/g, " ").toLowerCase().replace(/^\w/, (c) => c.toUpperCase());

/** Chart colors come from CSS tokens so light/dark stay in one place. */
export function useColors() {
  const read = () => {
    const cs = getComputedStyle(document.documentElement);
    const v = (n: string) => cs.getPropertyValue(n).trim();
    return {
      s1: v("--series-1"), s2: v("--series-2"), s3: v("--series-3"), grid: v("--grid"), axis: v("--axis"),
      muted: v("--muted"), ink2: v("--ink-2"), surface: v("--surface"), critical: v("--critical"),
      seqLo: v("--seq-100"), seqHi: v("--seq-700"),
    };
  };
  const [c, setC] = useState(read);
  useEffect(() => {
    const mq = matchMedia("(prefers-color-scheme: dark)");
    const on = () => setC(read());
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);
  return c;
}

export const axisProps = (c: ReturnType<typeof useColors>) => ({
  stroke: c.axis, tick: { fill: c.muted, fontSize: 11.5 }, tickLine: false,
});

type TipRow = { name: string; value: string; color?: string };
export function Tip({ title, rows }: { title: string; rows: TipRow[] }) {
  return (
    <div className="tooltip">
      <div className="t">{title}</div>
      {rows.map((r) => (
        <div className="row" key={r.name}>
          {r.color && <span className="sw" style={{ background: r.color }} />}
          {r.name}<b>{r.value}</b>
        </div>
      ))}
    </div>
  );
}

export function Result({ r }: { r: string }) {
  const icon = r === "pass" ? "✓" : r === "rework" ? "↻" : r === "scrap" ? "✕" : "…";
  return <span className={`pill ${r}`}>{icon} {r}</span>;
}

export function BBox({ b }: { b: { bbox_x: number | null; bbox_y: number | null; bbox_w: number | null; bbox_h: number | null } }) {
  if (b.bbox_x == null) return null;
  return <div className="bbox" style={{ left: `${b.bbox_x * 100}%`, top: `${b.bbox_y! * 100}%`, width: `${b.bbox_w! * 100}%`, height: `${b.bbox_h! * 100}%` }} />;
}

export type Det = {
  idx: number; class: string; size_mm: number; confidence: number;
  bbox_x: number; bbox_y: number; bbox_w: number; bbox_h: number;
};

/** The vision system's boxes on a transillumination scan, numbered as on the light table. */
export function Dets({ dets, limit }: { dets: Det[]; limit?: number }) {
  return (
    <>
      {dets.map((d) => (
        <div key={d.idx} className={`det${limit && d.size_mm > limit ? " over" : ""}`}
          style={{ left: `${d.bbox_x * 100}%`, top: `${d.bbox_y * 100}%`, width: `${d.bbox_w * 100}%`, height: `${d.bbox_h * 100}%` }}
          title={`${d.idx}: ${label(d.class)} ${d.size_mm.toFixed(2)} mm (${Math.round(d.confidence * 100)}%)`}>
          <span>{d.idx}</span>
        </div>
      ))}
    </>
  );
}

/** Interpolate the sequential ramp (lo -> hi) for heat cells. */
export function seq(t: number, lo: string, hi: string) {
  const p = (h: string) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
  const a = p(lo), b = p(hi);
  const k = Math.max(0, Math.min(1, t));
  return `rgb(${a.map((x, i) => Math.round(x + (b[i] - x) * k)).join(",")})`;
}
