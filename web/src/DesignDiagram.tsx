import { Factor, Run, settingLabel } from "./doe";

/**
 * The experiment drawn as a shape: a line (1 axis), square (2) or cube (3).
 * Numeric factors are the axes; each categorical combination gets its own panel.
 * With no numeric factors, the categorical factors become the axes.
 */

type Point = { key: string; x: number[]; runs: Run[] };

/** Optional overlays: Run view (progress, deviations) and Analyze view (values). */
export type Overlay = {
  label?: (p: Point) => string;                 // replaces "×n"
  fill?: (p: Point) => string | undefined;      // replaces the default point colour
  ring?: (p: Point) => number;                  // 0..1 progress ring around the point
  deviations?: { planned: number[]; actual: number[]; runNo: number }[];  // coded
  selected?: string | null;
  onSelect?: (key: string | null) => void;
  tooltip?: (p: Point) => string;
};
const S = 150; // edge length

function project(axes: number, v: number[]): [number, number] {
  const [a = 0, b = 0, c = 0] = v.map((t) => (t + 1) / 2);
  if (axes === 1) return [a * S * 1.3, 0];
  if (axes === 2) return [a * S, -b * S];
  return [a * S + c * S * 0.5, -b * S - c * S * 0.35];
}

function Axis({ f, from, to, side }: { f: Factor; from: [number, number]; to: [number, number]; side: "below" | "left" | "depth" }) {
  const lo = settingLabel(f, -1), hi = settingLabel(f, 1);
  const mid: [number, number] = [(from[0] + to[0]) / 2, (from[1] + to[1]) / 2];
  const st = { fill: "var(--muted)", fontSize: 11 };
  const nm = { fill: "var(--ink-2)", fontSize: 12, fontWeight: 600 };
  if (side === "below")
    return (<g>
      <text x={from[0]} y={from[1] + 22} textAnchor="middle" style={st}>{lo}</text>
      <text x={to[0]} y={to[1] + 22} textAnchor="middle" style={st}>{hi}</text>
      <text x={mid[0]} y={mid[1] + 40} textAnchor="middle" style={nm}>{f.name}</text>
    </g>);
  if (side === "left")
    return (<g>
      <text x={from[0] - 14} y={from[1] + 4} textAnchor="end" style={st}>{lo}</text>
      <text x={to[0] - 14} y={to[1] + 4} textAnchor="end" style={st}>{hi}</text>
      <text x={mid[0] - 14} y={mid[1] + 4} textAnchor="end" style={nm}>{f.name}</text>
    </g>);
  return (<g>
    <text x={to[0] + 14} y={to[1] + 4} style={st}>{hi}</text>
    <text x={from[0] + 14} y={from[1] + 16} style={st}>{lo}</text>
    <text x={mid[0] + 18} y={mid[1] + 12} style={nm}>{f.name}</text>
  </g>);
}

function Panel({ factors, axisIdx, points, title, overlay, devs }: { factors: Factor[]; axisIdx: number[]; points: Point[]; title?: string; overlay?: Overlay; devs: Overlay["deviations"] }) {
  const n = axisIdx.length;
  const cornersList = Array.from({ length: 2 ** n }, (_, i) => axisIdx.map((_, j) => ((i >> j) & 1 ? 1 : -1)));
  const edges: [number[], number[]][] = [];
  for (const a of cornersList) for (let j = 0; j < n; j++) if (a[j] < 0) { const b = [...a]; b[j] = 1; edges.push([a, b]); }
  const p = (v: number[]) => project(n, v);

  // bounding box for the viewBox, with room for labels
  const xs = cornersList.map((c) => p(c)[0]), ys = cornersList.map((c) => p(c)[1]);
  const pad = { l: n >= 2 ? 110 : 40, r: n === 3 ? 90 : 70, t: title ? 58 : 32, b: 56 };
  const x0 = Math.min(...xs) - pad.l, y0 = Math.min(...ys) - pad.t;
  const w = Math.max(...xs) - Math.min(...xs) + pad.l + pad.r, h = Math.max(...ys) - Math.min(...ys) + pad.t + pad.b;

  const tip = (pt: Point) => {
    const s = factors.map((f, i) => `${f.name}: ${settingLabel(f, pt.x[i])}`).join("\n");
    const kind = pt.runs[0].pointType === "center" ? "Centre point" : "Corner";
    return `${kind}\n${s}\nRuns: ${pt.runs.map((r) => r.runNo).join(", ")}${overlay?.tooltip ? `\n${overlay.tooltip(pt)}` : ""}`;
  };
  const clamp = (v: number) => Math.max(-1.35, Math.min(1.35, v));

  return (
    <svg viewBox={`${x0} ${y0} ${w} ${h}`} style={{ width: "100%", maxWidth: w * 1.15, height: "auto", display: "block" }} role="img"
      aria-label={`Design ${title ?? ""}: ${points.length} settings`}>
      {title && <text x={x0 + w / 2} y={y0 + 18} textAnchor="middle" style={{ fill: "var(--ink)", fontSize: 13, fontWeight: 600 }}>{title}</text>}
      {edges.map(([a, b], i) => {
        const [ax, ay] = p(a), [bx, by] = p(b);
        return <line key={i} x1={ax} y1={ay} x2={bx} y2={by} style={{ stroke: "var(--axis)", strokeWidth: 1.5 }} />;
      })}
      {/* axes labels */}
      <Axis f={factors[axisIdx[0]]} from={p(axisIdx.map(() => -1))} to={p(axisIdx.map((_, j) => (j === 0 ? 1 : -1)))} side="below" />
      {n >= 2 && <Axis f={factors[axisIdx[1]]} from={p(axisIdx.map(() => -1))} to={p(axisIdx.map((_, j) => (j === 1 ? 1 : -1)))} side="left" />}
      {n === 3 && <Axis f={factors[axisIdx[2]]} from={p([1, -1, -1])} to={p([1, -1, 1])} side="depth" />}
      {(devs ?? []).map((d) => {
        const [px, py] = p(axisIdx.map((j) => d.planned[j]));
        const [ax, ay] = p(axisIdx.map((j) => clamp(d.actual[j])));
        return (
          <g key={`d${d.runNo}`}>
            <title>{`Run ${d.runNo} ran at a different setting than planned`}</title>
            <line x1={px} y1={py} x2={ax} y2={ay} style={{ stroke: "var(--critical)", strokeWidth: 1.2, strokeDasharray: "3 2" }} />
            <circle cx={ax} cy={ay} r={4.5} style={{ fill: "var(--surface)", stroke: "var(--critical)", strokeWidth: 1.8 }} />
          </g>
        );
      })}
      {points.map((pt, i) => {
        const [x, y] = p(axisIdx.map((j) => pt.x[j]));
        const center = pt.runs[0].pointType === "center";
        const count = pt.runs.length;
        const fill = overlay?.fill?.(pt) ?? (center ? "var(--series-2)" : "var(--accent)");
        const ring = overlay?.ring?.(pt);
        const sel = overlay?.selected === pt.key;
        const r = 9, circ = 2 * Math.PI * (r + 4);
        return (
          <g key={i} style={{ cursor: overlay?.onSelect ? "pointer" : "default" }}
            onClick={() => overlay?.onSelect?.(sel ? null : pt.key)}>
            <title>{tip(pt)}</title>
            <circle cx={x} cy={y} r={18} style={{ fill: "transparent" }} />
            {sel && <circle cx={x} cy={y} r={17} style={{ fill: "none", stroke: "var(--ink)", strokeWidth: 1.5 }} />}
            {ring != null && <>
              <circle cx={x} cy={y} r={r + 4} style={{ fill: "none", stroke: "var(--grid)", strokeWidth: 3 }} />
              <circle cx={x} cy={y} r={r + 4} style={{ fill: "none", stroke: "var(--good)", strokeWidth: 3 }}
                strokeDasharray={`${circ * ring} ${circ}`} transform={`rotate(-90 ${x} ${y})`} />
            </>}
            {center
              ? <rect x={x - 7} y={y - 7} width={14} height={14} transform={`rotate(45 ${x} ${y})`} style={{ fill, stroke: "var(--surface)", strokeWidth: 2 }} />
              : <circle cx={x} cy={y} r={7.5} style={{ fill, stroke: "var(--surface)", strokeWidth: 2 }} />}
            <text x={x + 13} y={y - 11} style={{ fill: "var(--ink)", fontSize: 12, fontWeight: 600 }}>{overlay?.label ? overlay.label(pt) : `×${count}`}</text>
          </g>
        );
      })}
    </svg>
  );
}

export const pointKey = (r: { pointType: string; x: number[] }) => `${r.pointType}:${r.x.join(",")}`;

export default function DesignDiagram({ factors, runs, overlay }: { factors: Factor[]; runs: Run[]; overlay?: Overlay }) {
  const numIdx = factors.map((f, i) => (f.kind === "numeric" ? i : -1)).filter((i) => i >= 0);
  const catIdx = factors.map((f, i) => (f.kind === "categorical" ? i : -1)).filter((i) => i >= 0);
  const axisIdx = numIdx.length ? numIdx : catIdx;
  const panelIdx = numIdx.length ? catIdx : [];

  // group runs into design points
  const byKey = new Map<string, Point>();
  for (const r of runs) {
    const key = `${r.pointType}:${r.x.join(",")}`;
    if (!byKey.has(key)) byKey.set(key, { key, x: r.x, runs: [] });
    byKey.get(key)!.runs.push(r);
  }
  const points = [...byKey.values()];
  const combos = Array.from({ length: 2 ** panelIdx.length }, (_, i) => panelIdx.map((_, j) => ((i >> j) & 1 ? 1 : -1)));

  return (
    <div style={{ display: "grid", gridTemplateColumns: `repeat(${combos.length > 2 ? 2 : combos.length}, minmax(0, 1fr))`, gap: 8, alignItems: "end" }}>
      {combos.map((combo, ci) => (
        <Panel key={ci} factors={factors} axisIdx={axisIdx}
          title={panelIdx.length ? panelIdx.map((fi, j) => `${factors[fi].name}: ${settingLabel(factors[fi], combo[j])}`).join(" · ") : undefined}
          points={points.filter((pt) => panelIdx.every((fi, j) => pt.x[fi] === combo[j]))} overlay={overlay}
          devs={overlay?.deviations?.filter((d) => panelIdx.every((fi, j) => d.planned[fi] === combo[j]))} />
      ))}
    </div>
  );
}
