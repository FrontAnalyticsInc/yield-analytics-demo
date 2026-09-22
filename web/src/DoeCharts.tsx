/** Small SVG charts for experiment analysis. Colours come from CSS tokens. */

type Term = { term: string; kind: string; effect: number; lo: number; hi: number; p: number; verdict: string | null };
type MeanCI = { n: number; mean: number | null; lo: number | null; hi: number | null };

const fmt = (v: number) => (Math.abs(v) >= 100 ? v.toFixed(1) : Math.abs(v) >= 1 ? v.toFixed(2) : v.toPrecision(2));
const VERDICT: Record<string, [string, string]> = {
  real: ["var(--accent)", "Real effect"], none: ["var(--muted)", "No meaningful effect"], unclear: ["var(--axis)", "Unclear"],
};

function niceTicks(lo: number, hi: number, n = 5) {
  const span = hi - lo || 1;
  const step0 = span / n, mag = 10 ** Math.floor(Math.log10(step0));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => span / s <= n) ?? mag * 10;
  const out = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + 1e-12; v += step) out.push(+v.toPrecision(10));
  return out;
}

/** Horizontal effect bars with 95% ranges and the "smallest change that matters" band. */
export function EffectsChart({ terms, delta, unit }: { terms: Term[]; delta: number; unit: string }) {
  const rows = terms.filter((t) => t.kind !== "intercept");
  const W = 640, rowH = 34, labelW = 230, padR = 70, top = 26;
  const H = top + rows.length * rowH + 30;
  const ext = Math.max(delta * 1.4, ...rows.map((r) => Math.max(Math.abs(r.lo), Math.abs(r.hi)))) * 1.08;
  const x = (v: number) => labelW + ((v + ext) / (2 * ext)) * (W - labelW - padR);
  const ticks = niceTicks(-ext, ext, 6);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} style={{ width: "100%", height: "auto" }} role="img" aria-label="Effect of each factor with 95% range">
      <rect x={x(-delta)} y={top - 6} width={x(delta) - x(-delta)} height={rows.length * rowH + 6} style={{ fill: "var(--surface-2)" }} />
      <text x={x(0)} y={top - 12} textAnchor="middle" style={{ fill: "var(--muted)", fontSize: 11 }}>
        shaded: smaller than {fmt(delta)} {unit} (doesn't matter)
      </text>
      {ticks.map((t) => (
        <g key={t}>
          <line x1={x(t)} x2={x(t)} y1={top - 6} y2={top + rows.length * rowH} style={{ stroke: t === 0 ? "var(--axis)" : "var(--grid)", strokeWidth: t === 0 ? 1.5 : 1 }} />
          <text x={x(t)} y={top + rows.length * rowH + 16} textAnchor="middle" style={{ fill: "var(--muted)", fontSize: 11 }}>{fmt(t)}</text>
        </g>
      ))}
      {rows.map((r, i) => {
        const cy = top + i * rowH + rowH / 2;
        const [color] = VERDICT[r.verdict ?? "unclear"];
        return (
          <g key={r.term}>
            <title>{`${r.term}\nEffect ${fmt(r.effect)} ${unit} (95% range ${fmt(r.lo)} to ${fmt(r.hi)})\np = ${r.p < 0.001 ? "<0.001" : r.p.toFixed(3)} · ${VERDICT[r.verdict ?? "unclear"][1]}`}</title>
            <rect x={0} y={cy - rowH / 2} width={W} height={rowH} style={{ fill: "transparent" }} />
            <text x={labelW - 10} y={cy + 4} textAnchor="end" style={{ fill: "var(--ink-2)", fontSize: 12.5 }}>{r.term.length > 32 ? r.term.slice(0, 31) + "…" : r.term}</text>
            <line x1={x(r.lo)} x2={x(r.hi)} y1={cy} y2={cy} style={{ stroke: color, strokeWidth: 2 }} />
            <line x1={x(r.lo)} x2={x(r.lo)} y1={cy - 5} y2={cy + 5} style={{ stroke: color, strokeWidth: 2 }} />
            <line x1={x(r.hi)} x2={x(r.hi)} y1={cy - 5} y2={cy + 5} style={{ stroke: color, strokeWidth: 2 }} />
            <circle cx={x(r.effect)} cy={cy} r={6} style={{ fill: color, stroke: "var(--surface)", strokeWidth: 2 }} />
            <text x={W - padR + 8} y={cy + 4} style={{ fill: "var(--ink)", fontSize: 12, fontWeight: 600 }}>{r.effect > 0 ? "+" : ""}{fmt(r.effect)}</text>
          </g>
        );
      })}
    </svg>
  );
}

/** Mean result at low vs high for each factor, one small panel each, shared y-scale. */
export function MainEffects({ plots, labels, domain, unit, target }: {
  plots: { factor: string; low: MeanCI; high: MeanCI }[]; labels: [string, string][]; domain: [number, number]; unit: string; target: number | null;
}) {
  const PW = 200, H = 190, padL = 46, padB = 40, padT = 26;
  const [d0, d1] = domain;
  const y = (v: number) => padT + (1 - (v - d0) / (d1 - d0)) * (H - padT - padB);
  const ticks = niceTicks(d0, d1, 4);
  return (
    <svg viewBox={`0 0 ${plots.length * PW + padL} ${H}`} style={{ width: "100%", height: "auto" }} role="img" aria-label="Main effects">
      {ticks.map((t) => (
        <g key={t}>
          <text x={padL - 6} y={y(t) + 4} textAnchor="end" style={{ fill: "var(--muted)", fontSize: 10.5 }}>{fmt(t)}</text>
          <line x1={padL} x2={plots.length * PW + padL} y1={y(t)} y2={y(t)} style={{ stroke: "var(--grid)" }} />
        </g>
      ))}
      {target != null && target >= d0 && target <= d1 && (
        <g><line x1={padL} x2={plots.length * PW + padL} y1={y(target)} y2={y(target)} style={{ stroke: "var(--good)", strokeDasharray: "4 3" }} />
          <text x={plots.length * PW + padL - 4} y={y(target) - 4} textAnchor="end" style={{ fill: "var(--good-text)", fontSize: 10.5 }}>target</text></g>
      )}
      {plots.map((p, i) => {
        const x0 = padL + i * PW + 34, x1 = padL + (i + 1) * PW - 34;
        const pts: [number, MeanCI, string][] = [[x0, p.low, labels[i][0]], [x1, p.high, labels[i][1]]];
        return (
          <g key={p.factor}>
            <text x={(x0 + x1) / 2} y={14} textAnchor="middle" style={{ fill: "var(--ink)", fontSize: 12, fontWeight: 600 }}>{p.factor.length > 26 ? p.factor.slice(0, 25) + "…" : p.factor}</text>
            {p.low.mean != null && p.high.mean != null && <line x1={x0} x2={x1} y1={y(p.low.mean)} y2={y(p.high.mean)} style={{ stroke: "var(--accent)", strokeWidth: 2 }} />}
            {pts.map(([xx, m, lbl]) => m.mean != null && (
              <g key={lbl}>
                <title>{`${p.factor} = ${lbl}\nMean ${fmt(m.mean)} ${unit} (n=${m.n})\n95% range ${fmt(m.lo!)} to ${fmt(m.hi!)}`}</title>
                <line x1={xx} x2={xx} y1={y(m.lo!)} y2={y(m.hi!)} style={{ stroke: "var(--accent)", strokeWidth: 1.5, opacity: 0.6 }} />
                <circle cx={xx} cy={y(m.mean)} r={5.5} style={{ fill: "var(--accent)", stroke: "var(--surface)", strokeWidth: 2 }} />
                <text x={xx} y={H - padB + 16} textAnchor="middle" style={{ fill: "var(--muted)", fontSize: 11 }}>{lbl}</text>
              </g>
            ))}
            {i > 0 && <line x1={padL + i * PW} x2={padL + i * PW} y1={padT} y2={H - padB} style={{ stroke: "var(--grid)" }} />}
          </g>
        );
      })}
      <text x={10} y={padT - 10} style={{ fill: "var(--muted)", fontSize: 10.5 }}>{unit}</text>
    </svg>
  );
}

/** Interaction plot: one line per level of factor B across factor A. Parallel lines = no interaction. */
export function InteractionPlot({ cells, aName, bName, aLabels, bLabels, domain, unit }: {
  cells: Record<string, MeanCI>; aName: string; bName: string; aLabels: [string, string]; bLabels: [string, string]; domain: [number, number]; unit: string;
}) {
  const W = 320, H = 230, padL = 46, padR = 70, padB = 40, padT = 48;
  const [d0, d1] = domain;
  const y = (v: number) => padT + (1 - (v - d0) / (d1 - d0)) * (H - padT - padB);
  const xs = [padL + 30, W - padR - 30];
  const colors = ["var(--series-1)", "var(--series-2)"];
  return (
    <svg viewBox={`0 0 ${W} ${H}`} style={{ width: "100%", height: "auto" }} role="img" aria-label={`Interaction of ${aName} and ${bName}`}>
      {niceTicks(d0, d1, 4).map((t) => (
        <g key={t}><text x={padL - 6} y={y(t) + 4} textAnchor="end" style={{ fill: "var(--muted)", fontSize: 10.5 }}>{fmt(t)}</text>
          <line x1={padL} x2={W - padR} y1={y(t)} y2={y(t)} style={{ stroke: "var(--grid)" }} /></g>
      ))}
      {(["L", "H"] as const).map((b, bi) => {
        const lo = cells[`L${b}`], hi = cells[`H${b}`];
        const lx = xs[1] + 4;
        return (
          <g key={b}>
            {lo?.mean != null && hi?.mean != null && <line x1={xs[0]} x2={xs[1]} y1={y(lo.mean)} y2={y(hi.mean)} style={{ stroke: colors[bi], strokeWidth: 2 }} />}
            {[lo, hi].map((m, ai) => m?.mean != null && (
              <g key={ai}><title>{`${aName} = ${aLabels[ai]}, ${bName} = ${bLabels[bi]}\nMean ${fmt(m.mean)} ${unit} (n=${m.n})`}</title>
                <circle cx={xs[ai]} cy={y(m.mean)} r={5} style={{ fill: colors[bi], stroke: "var(--surface)", strokeWidth: 2 }} /></g>
            ))}
            {hi?.mean != null && <text x={lx} y={y(hi.mean) + 4} style={{ fill: "var(--ink-2)", fontSize: 10.5 }}>{bLabels[bi]}</text>}
          </g>
        );
      })}
      {xs.map((xx, i) => <text key={i} x={xx} y={H - padB + 16} textAnchor="middle" style={{ fill: "var(--muted)", fontSize: 11 }}>{aLabels[i]}</text>)}
      <text x={(xs[0] + xs[1]) / 2} y={H - 6} textAnchor="middle" style={{ fill: "var(--ink-2)", fontSize: 11.5, fontWeight: 600 }}>{aName}</text>
      <g transform={`translate(${padL}, 14)`}>
        <text style={{ fill: "var(--ink-2)", fontSize: 11 }}>{bName.length > 22 ? bName.slice(0, 21) + "…" : bName}:</text>
        {bLabels.map((l, i) => (
          <g key={i} transform={`translate(${i * 110}, 16)`}>
            <rect x={0} y={-8} width={12} height={3} rx={1.5} style={{ fill: colors[i] }} />
            <text x={16} y={-3} style={{ fill: "var(--ink-2)", fontSize: 11 }}>{l.length > 14 ? l.slice(0, 13) + "…" : l}</text>
          </g>
        ))}
      </g>
    </svg>
  );
}
