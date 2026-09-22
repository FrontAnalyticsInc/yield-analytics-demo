/**
 * Two-level full factorial designs with centre points.
 *
 * Corners: every low/high combination of 2-3 factors, repeated `replicates` times.
 * Centre points: the middle of the numeric factors only. Categorical factors keep a
 * real value, so centres are split across the categorical combinations. Centres are
 * spread evenly through the run order (start / middle / end) so they double as a
 * drift check; corners are shuffled in between.
 */

export type Factor = {
  name: string;
  kind: "numeric" | "categorical";
  units: string;
  low: number;
  high: number;
  lowLabel: string;
  highLabel: string;
};

export type Run = {
  runNo: number;          // 1-based execution order
  pointType: "corner" | "center";
  replicate: number;      // 1-based within its design point
  x: number[];            // coded -1 / 0 / +1 per factor
};

// --- normal distribution -------------------------------------------------------------

/** Inverse standard normal CDF (Acklam's rational approximation, |error| < 1.2e-9). */
export function zq(p: number): number {
  const a = [-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.38357751867269e2, -3.066479806614716e1, 2.506628277459239];
  const b = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1, -1.328068155288572e1];
  const c = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416];
  const lo = 0.02425;
  if (p < lo) {
    const q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  if (p > 1 - lo) return -zq(1 - p);
  const q = p - 0.5, r = q * q;
  return ((((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q) / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
}

/** Standard normal CDF. */
export function phi(x: number): number {
  // Abramowitz & Stegun 7.1.26 on erf
  const t = 1 / (1 + 0.3275911 * Math.abs(x) / Math.SQRT2);
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-(x * x) / 2);
  return x >= 0 ? (1 + y) / 2 : (1 - y) / 2;
}

// --- sizing --------------------------------------------------------------------------

/**
 * In a two-level factorial every corner run contributes to every main effect:
 * effect = mean(high) - mean(low), so Var(effect) = 4σ²/N for N corner runs.
 */
export function cornerRunsNeeded(sigma: number, effect: number, alpha: number, power: number) {
  const z = zq(1 - alpha / 2) + zq(power);
  return (4 * sigma * sigma * z * z) / (effect * effect);
}

export function detectionChance(sigma: number, effect: number, alpha: number, cornerRuns: number) {
  if (sigma <= 0 || cornerRuns <= 0) return 0;
  const se = (2 * sigma) / Math.sqrt(cornerRuns);
  return phi(Math.abs(effect) / se - zq(1 - alpha / 2));
}

export function recommendedReplicates(k: number, sigma: number, effect: number, alpha: number, power: number) {
  if (!(sigma > 0) || !(effect > 0)) return 1;
  return Math.max(1, Math.ceil(cornerRunsNeeded(sigma, effect, alpha, power) / 2 ** k));
}

// --- centre points -------------------------------------------------------------------

export type CenterRule = { applicable: boolean; combos: number; defaultPerCombo: number; note: string };

export function centerRule(factors: Factor[]): CenterRule {
  const numeric = factors.filter((f) => f.kind === "numeric").length;
  const cats = factors.length - numeric;
  if (numeric === 0) return { applicable: false, combos: 0, defaultPerCombo: 0, note: "Not applicable: no numeric factors have a middle setting." };
  if (cats === 0) return { applicable: true, combos: 1, defaultPerCombo: 3, note: "Run at the start, middle and end to check curvature and drift." };
  if (cats === 1) return { applicable: true, combos: 2, defaultPerCombo: 2, note: "Middle of the numeric factors, at each categorical value (one early, one late)." };
  return { applicable: true, combos: 4, defaultPerCombo: 1, note: "Middle of the numeric factor at each categorical combination. Drift check is limited." };
}

// --- run generation ----------------------------------------------------------------------

function rng(seed: number) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0;
    return s / 4294967296;
  };
}

/** All ±1 combinations for k factors, standard (Yates) order. */
export function corners(k: number): number[][] {
  return Array.from({ length: 2 ** k }, (_, i) => Array.from({ length: k }, (_, j) => ((i >> j) & 1 ? 1 : -1)));
}

/** Centre points: 0 for numeric, each ±1 combination of the categorical factors. */
export function centerPoints(factors: Factor[]): number[][] {
  const catIdx = factors.map((f, i) => (f.kind === "categorical" ? i : -1)).filter((i) => i >= 0);
  return corners(catIdx.length).map((combo) => factors.map((f, i) => (f.kind === "numeric" ? 0 : combo[catIdx.indexOf(i)])));
}

export function buildRuns(factors: Factor[], replicates: number, centersPerCombo: number, seed: number): Run[] {
  const k = factors.length;
  const rand = rng(seed);
  const cornerRuns: Omit<Run, "runNo">[] = [];
  for (let r = 1; r <= replicates; r++) for (const x of corners(k)) cornerRuns.push({ pointType: "corner", replicate: r, x });
  for (let i = cornerRuns.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [cornerRuns[i], cornerRuns[j]] = [cornerRuns[j], cornerRuns[i]];
  }

  const rule = centerRule(factors);
  const combos = rule.applicable ? centerPoints(factors) : [];
  // interleave combos (A, B, A, B...) so each categorical value gets an early and a late centre
  const centers: Omit<Run, "runNo">[] = [];
  for (let r = 1; r <= centersPerCombo; r++) for (const x of combos) centers.push({ pointType: "center", replicate: r, x });

  const total = cornerRuns.length + centers.length;
  const slots = new Map<number, Omit<Run, "runNo">>();
  centers.forEach((c, i) => {
    let pos = centers.length === 1 ? Math.floor(total / 2) : Math.round((i * (total - 1)) / (centers.length - 1));
    while (slots.has(pos)) pos++;
    slots.set(pos, c);
  });
  const out: Run[] = [];
  let ci = 0;
  for (let pos = 0; pos < total; pos++) {
    const r = slots.get(pos) ?? cornerRuns[ci++];
    out.push({ ...r, runNo: pos + 1 });
  }
  return out;
}

// --- display helpers -------------------------------------------------------------------

export function settingLabel(f: Factor, coded: number): string {
  if (f.kind === "categorical") return coded < 0 ? f.lowLabel : f.highLabel;
  const v = coded < 0 ? f.low : coded > 0 ? f.high : (f.low + f.high) / 2;
  return `${+v.toFixed(4)}${f.units ? ` ${f.units}` : ""}`;
}

export function validateFactors(factors: Factor[]): string[] {
  const errs: string[] = [];
  const names = new Set<string>();
  factors.forEach((f, i) => {
    const n = f.name.trim() || `Factor ${i + 1}`;
    if (!f.name.trim()) errs.push(`Factor ${i + 1} needs a name.`);
    if (names.has(n.toLowerCase())) errs.push(`Two factors are named "${n}".`);
    names.add(n.toLowerCase());
    if (f.kind === "numeric" && !(f.high > f.low)) errs.push(`${n}: high setting must be greater than low.`);
    if (f.kind === "categorical" && (!f.lowLabel.trim() || !f.highLabel.trim() || f.lowLabel.trim() === f.highLabel.trim()))
      errs.push(`${n}: enter two different values.`);
  });
  return errs;
}
