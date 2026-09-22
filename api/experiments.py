"""Design of experiments: design, run tracking, simulation and analysis.

Coded units: every factor is analysed on a -1 (low) .. +1 (high) scale, so effects
are comparable. Numeric actual settings are stored in real units and coded on the
fly; categorical settings are stored as -1 / +1.
"""

import itertools
import json
import math
import random

import numpy as np
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field
from scipy import stats

from db import connect, execute, q

router = APIRouter(prefix="/api")


# --- loading ---------------------------------------------------------------------------

def _factors(eid: int) -> list[dict]:
    return q("SELECT * FROM mfg.experiment_factor WHERE experiment_id=%s ORDER BY factor_no", (eid,))


def _real(f: dict, coded: float) -> float:
    """Coded setting -> real units (numeric) or ±1 (categorical)."""
    if f["kind"] == "categorical":
        return coded
    mid, half = (f["low_value"] + f["high_value"]) / 2, (f["high_value"] - f["low_value"]) / 2
    return mid + coded * half


def _coded(f: dict, real: float) -> float:
    if f["kind"] == "categorical":
        return real
    mid, half = (f["low_value"] + f["high_value"]) / 2, (f["high_value"] - f["low_value"]) / 2
    return (real - mid) / half


def _experiment(eid: int) -> dict:
    e = q("""SELECT e.*, o.name created_by_name, s.name response, s.param_name, s.param_unit, s.lsl, s.target, s.usl
             FROM mfg.experiment e JOIN mfg.step s ON s.step_id=e.response_step_id
             JOIN mfg.operator o ON o.operator_id=e.created_by WHERE e.experiment_id=%s""", (eid,))
    if not e:
        raise HTTPException(404, "experiment not found")
    return e[0]


def _runs(e: dict, factors: list[dict]) -> list[dict]:
    """Planned runs joined with execution state and the response (manual, simulated or from the line)."""
    k = len(factors)
    rows = q("""
        SELECT r.run_no, r.point_type, r.replicate, r.x1, r.x2, r.x3,
               u.serial, u.simulated, u.assigned_by, u.assigned_at, u.confirmed_by, u.confirmed_at, u.as_planned,
               u.actual_1, u.actual_2, u.actual_3, u.deviation_note, u.response, u.response_source,
               un.status unit_status, line.value line_value, line.ended_at line_at
        FROM mfg.experiment_run r
        LEFT JOIN mfg.experiment_unit u ON u.experiment_id=r.experiment_id AND u.run_no=r.run_no
        LEFT JOIN mfg.unit un ON un.serial=u.serial
        OUTER APPLY (SELECT TOP 1 m.value, ev.ended_at FROM mfg.step_event ev JOIN mfg.measurement m ON m.event_id=ev.event_id
                     WHERE ev.serial=u.serial AND ev.step_id=%s AND ev.attempt=1) line
        WHERE r.experiment_id=%s ORDER BY r.run_no""", (e["response_step_id"], e["experiment_id"]))
    out = []
    for r in rows:
        planned = [r["x1"], r["x2"], r["x3"]][:k]
        actual_real = [r["actual_1"], r["actual_2"], r["actual_3"]][:k]
        response, source = r["response"], r["response_source"]
        if response is None and r["line_value"] is not None:
            response, source = r["line_value"], "line"
        state = ("measured" if response is not None else "confirmed" if r["as_planned"] is not None
                 else "assigned" if r["serial"] else "planned")
        actual_coded = ([_coded(f, v) for f, v in zip(factors, actual_real)]
                        if r["as_planned"] is not None else None)
        out.append({
            "runNo": r["run_no"], "pointType": r["point_type"], "replicate": r["replicate"], "x": planned,
            "planned": [_real(f, x) for f, x in zip(factors, planned)],
            "serial": r["serial"], "simulated": bool(r["simulated"]) if r["serial"] else False,
            "unitStatus": r["unit_status"], "assignedBy": r["assigned_by"], "assignedAt": r["assigned_at"],
            "confirmedBy": r["confirmed_by"], "confirmedAt": r["confirmed_at"],
            "asPlanned": None if r["as_planned"] is None else bool(r["as_planned"]),
            "actual": actual_real if r["as_planned"] is not None else None, "actualCoded": actual_coded,
            "deviationNote": r["deviation_note"], "response": response, "responseSource": source, "state": state,
        })
    return out


def _factor_out(f: dict) -> dict:
    return {"name": f["name"], "kind": f["kind"], "units": f["units"] or "", "low": f["low_value"] or 0,
            "high": f["high_value"] or 0, "lowLabel": f["low_label"] or "", "highLabel": f["high_label"] or ""}


# --- design ------------------------------------------------------------------------------

@router.get("/doe/noise/{step_id}")
def doe_noise(step_id: int, days: int = 90):
    """Process noise for a measurement step, used to size an experiment."""
    st = q("SELECT * FROM mfg.step WHERE step_id=%s AND step_type='measurement'", (step_id,))
    if not st:
        raise HTTPException(404, "not a measurement step")
    r = q("""
        SELECT COUNT(*) n, AVG(m.value) mean, STDEV(m.value) sd
        FROM mfg.step_event ev JOIN mfg.measurement m ON m.event_id=ev.event_id
        WHERE ev.step_id=%s AND ev.attempt=1 AND ev.ended_at >= DATEADD(day, -%s, SYSUTCDATETIME())""", (step_id, days))[0]
    return {"step": st[0], "days": days, **r}


class FactorIn(BaseModel):
    name: str = Field(min_length=1, max_length=60)
    kind: str = Field(pattern="^(numeric|categorical)$")
    units: str = Field("", max_length=20)
    low: float | None = None
    high: float | None = None
    lowLabel: str = Field("", max_length=40)
    highLabel: str = Field("", max_length=40)


class RunIn(BaseModel):
    runNo: int
    pointType: str = Field(pattern="^(corner|center)$")
    replicate: int
    x: list[int]


class ExperimentIn(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    objective: str = Field("", max_length=400)
    notes: str = ""
    created_by: str
    response_step_id: int
    sigma: float = Field(gt=0)
    effect_size: float = Field(gt=0)
    alpha: float = Field(gt=0, lt=0.5)
    power_target: float = Field(gt=0.5, lt=1)
    replicates: int = Field(ge=1, le=20)
    center_points: int = Field(ge=0, le=20)
    seed: int
    factors: list[FactorIn] = Field(min_length=1, max_length=3)
    runs: list[RunIn]


@router.post("/experiments", status_code=201)
def create_experiment(e: ExperimentIn):
    k = len(e.factors)
    for f in e.factors:
        if f.kind == "numeric" and not (f.low is not None and f.high is not None and f.high > f.low):
            raise HTTPException(422, f"{f.name}: high must be greater than low")
        if f.kind == "categorical" and (not f.lowLabel or not f.highLabel or f.lowLabel == f.highLabel):
            raise HTTPException(422, f"{f.name}: two different values required")
    corners = [r for r in e.runs if r.pointType == "corner"]
    centers = [r for r in e.runs if r.pointType == "center"]
    if len(corners) != e.replicates * 2 ** k or len(centers) != e.center_points:
        raise HTTPException(422, "run list does not match replicates / centre points")
    if sorted(r.runNo for r in e.runs) != list(range(1, len(e.runs) + 1)) or any(len(r.x) != k for r in e.runs):
        raise HTTPException(422, "malformed run list")
    if not q("SELECT 1 x FROM mfg.operator WHERE operator_id=%s", (e.created_by,)):
        raise HTTPException(422, "unknown operator")

    conn = connect()
    try:
        cur = conn.cursor()
        cur.execute("""
            INSERT mfg.experiment (name, objective, notes, created_by, response_step_id, sigma, effect_size, alpha,
                                   power_target, replicates, center_points, seed)
            OUTPUT INSERTED.experiment_id
            VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)""",
                    (e.name, e.objective or None, e.notes or None, e.created_by, e.response_step_id, e.sigma,
                     e.effect_size, e.alpha, e.power_target, e.replicates, e.center_points, e.seed))
        eid = cur.fetchone()["experiment_id"]
        for i, f in enumerate(e.factors, 1):
            cur.execute("INSERT mfg.experiment_factor VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s)",
                        (eid, i, f.name, f.kind, f.units or None, f.low if f.kind == "numeric" else None,
                         f.high if f.kind == "numeric" else None, f.lowLabel if f.kind == "categorical" else None,
                         f.highLabel if f.kind == "categorical" else None))
        for r in e.runs:
            x = r.x + [None] * (3 - k)
            cur.execute("INSERT mfg.experiment_run VALUES (%s,%s,%s,%s,%s,%s,%s)",
                        (eid, r.runNo, r.pointType, r.replicate, x[0], x[1], x[2]))
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()
    return {"experiment_id": eid}


@router.get("/experiments")
def list_experiments():
    return q("""
        SELECT e.experiment_id, e.name, e.objective, e.status, e.created_at, e.created_by, o.name created_by_name,
               s.name response, (SELECT COUNT(*) FROM mfg.experiment_factor f WHERE f.experiment_id=e.experiment_id) factors,
               (SELECT COUNT(*) FROM mfg.experiment_run r WHERE r.experiment_id=e.experiment_id) runs,
               (SELECT COUNT(*) FROM mfg.experiment_unit u WHERE u.experiment_id=e.experiment_id) tagged,
               (SELECT COUNT(*) FROM mfg.experiment_unit u WHERE u.experiment_id=e.experiment_id
                  AND (u.response IS NOT NULL OR EXISTS (SELECT 1 FROM mfg.step_event ev WHERE ev.serial=u.serial
                       AND ev.step_id=e.response_step_id AND ev.attempt=1))) measured
        FROM mfg.experiment e JOIN mfg.step s ON s.step_id=e.response_step_id JOIN mfg.operator o ON o.operator_id=e.created_by
        ORDER BY e.created_at DESC""")


@router.get("/experiments/{eid}")
def get_experiment(eid: int):
    e = _experiment(eid)
    factors = _factors(eid)
    runs = _runs(e, factors)
    e.pop("sim_truth", None)
    return {**e, "factors": [_factor_out(f) for f in factors], "runs": runs,
            "progress": {s: sum(r["state"] == s for r in runs) for s in ("planned", "assigned", "confirmed", "measured")}}


# --- run tracking -------------------------------------------------------------------------

def _open(e: dict):
    if e["status"] not in ("planned", "running"):
        raise HTTPException(409, f"experiment is {e['status']}")


def _operator(op: str):
    if not q("SELECT 1 x FROM mfg.operator WHERE operator_id=%s", (op,)):
        raise HTTPException(422, "pick an operator")


def _run(eid: int, run_no: int) -> dict:
    r = q("""SELECT r.*, u.serial, u.as_planned FROM mfg.experiment_run r
             LEFT JOIN mfg.experiment_unit u ON u.experiment_id=r.experiment_id AND u.run_no=r.run_no
             WHERE r.experiment_id=%s AND r.run_no=%s""", (eid, run_no))
    if not r:
        raise HTTPException(404, "run not found")
    return r[0]


@router.get("/experiments/{eid}/eligible-units")
def eligible_units(eid: int, limit: int = 30):
    """In-process units that haven't reached the response step and aren't in any experiment."""
    e = _experiment(eid)
    return q("""
        SELECT TOP (%s) u.serial, u.model, u.lot_id, u.started_at,
               (SELECT MAX(step_id) FROM mfg.step_event ev WHERE ev.serial=u.serial) last_step
        FROM mfg.unit u
        WHERE u.status='wip'
          AND NOT EXISTS (SELECT 1 FROM mfg.step_event ev WHERE ev.serial=u.serial AND ev.step_id=%s)
          AND NOT EXISTS (SELECT 1 FROM mfg.experiment_unit x WHERE x.serial=u.serial)
        ORDER BY u.started_at DESC""", (limit, e["response_step_id"]))


class AssignIn(BaseModel):
    serial: str = Field(min_length=3, max_length=24)
    operator: str


@router.post("/experiments/{eid}/runs/{run_no}/assign")
def assign(eid: int, run_no: int, body: AssignIn):
    e = _experiment(eid)
    _open(e)
    _operator(body.operator)
    run = _run(eid, run_no)
    if run["serial"]:
        raise HTTPException(409, f"run {run_no} already has unit {run['serial']}")
    serial = body.serial.strip().upper()
    unit = q("SELECT serial, status FROM mfg.unit WHERE serial=%s", (serial,))
    if not unit:
        raise HTTPException(422, f"{serial} is not a known serial number")
    if unit[0]["status"] != "wip":
        raise HTTPException(422, f"{serial} is {unit[0]['status']}, not in process")
    if q("SELECT 1 x FROM mfg.step_event WHERE serial=%s AND step_id=%s", (serial, e["response_step_id"])):
        raise HTTPException(422, f"{serial} has already been measured at {e['response']}")
    other = q("""SELECT u.experiment_id, u.run_no, x.name FROM mfg.experiment_unit u
                 JOIN mfg.experiment x ON x.experiment_id=u.experiment_id WHERE u.serial=%s""", (serial,))
    if other:
        o = other[0]
        raise HTTPException(409, f"{serial} is already in EXP-{o['experiment_id']:04d} ({o['name']}), run {o['run_no']}")
    execute([("INSERT mfg.experiment_unit (experiment_id, run_no, serial, assigned_by) VALUES (%s,%s,%s,%s)",
              (eid, run_no, serial, body.operator)),
             ("UPDATE mfg.experiment SET status='running' WHERE experiment_id=%s AND status='planned'", (eid,))])
    return {"ok": True}


@router.delete("/experiments/{eid}/runs/{run_no}/assign")
def unassign(eid: int, run_no: int):
    _open(_experiment(eid))
    execute([("DELETE mfg.experiment_unit WHERE experiment_id=%s AND run_no=%s", (eid, run_no))])
    return {"ok": True}


class ConfirmIn(BaseModel):
    operator: str
    as_planned: bool
    actual: list[float] | None = None      # real units per factor (categorical: -1 / +1)
    note: str = Field("", max_length=200)


@router.post("/experiments/{eid}/runs/{run_no}/confirm")
def confirm(eid: int, run_no: int, body: ConfirmIn):
    e = _experiment(eid)
    _open(e)
    _operator(body.operator)
    factors = _factors(eid)
    run = _run(eid, run_no)
    if not run["serial"]:
        raise HTTPException(409, "tag a unit to this run first")
    planned = [_real(f, x) for f, x in zip(factors, [run["x1"], run["x2"], run["x3"]])]
    if body.as_planned:
        actual = planned
    else:
        if not body.actual or len(body.actual) != len(factors):
            raise HTTPException(422, "enter the setting that was actually used for each factor")
        if not body.note.strip():
            raise HTTPException(422, "add a short note on why the setting differed")
        actual = body.actual
        for f, v in zip(factors, actual):
            if f["kind"] == "categorical" and v not in (-1, 1):
                raise HTTPException(422, f"{f['name']}: pick one of the two values")
    a = actual + [None] * (3 - len(actual))
    execute([("""UPDATE mfg.experiment_unit SET confirmed_by=%s, confirmed_at=SYSUTCDATETIME(), as_planned=%s,
                   actual_1=%s, actual_2=%s, actual_3=%s, deviation_note=%s WHERE experiment_id=%s AND run_no=%s""",
              (body.operator, body.as_planned, a[0], a[1], a[2], None if body.as_planned else body.note.strip(), eid, run_no))])
    return {"ok": True}


class ResponseIn(BaseModel):
    value: float | None


@router.post("/experiments/{eid}/runs/{run_no}/response")
def manual_response(eid: int, run_no: int, body: ResponseIn):
    _open(_experiment(eid))
    if _run(eid, run_no)["as_planned"] is None:
        raise HTTPException(409, "confirm the settings before entering a result")
    execute([("UPDATE mfg.experiment_unit SET response=%s, response_source=%s WHERE experiment_id=%s AND run_no=%s",
              (body.value, "manual" if body.value is not None else None, eid, run_no))])
    return {"ok": True}


class StatusIn(BaseModel):
    status: str = Field(pattern="^(running|complete|cancelled)$")


@router.post("/experiments/{eid}/status")
def set_status(eid: int, body: StatusIn):
    e = _experiment(eid)
    stmts = [("UPDATE mfg.experiment SET status=%s WHERE experiment_id=%s", (body.status, eid))]
    if body.status == "cancelled":  # release the units so they can join another experiment
        stmts.insert(0, ("DELETE mfg.experiment_unit WHERE experiment_id=%s", (eid,)))
    if body.status == "running" and e["status"] == "cancelled":
        raise HTTPException(409, "a cancelled experiment cannot be reopened")
    execute(stmts)
    return {"ok": True}


# --- simulation ---------------------------------------------------------------------------

def _truth(e: dict, factors: list[dict]) -> dict:
    """Hidden 'real world' for the simulator: some factors matter, some don't."""
    rng = random.Random(f"truth-{e['experiment_id']}-{e['seed']}")
    d = e["effect_size"]
    effects = []
    for _ in factors:
        real = rng.random() < 0.6
        effects.append(round(rng.choice([-1, 1]) * (rng.uniform(1.1, 2.4) if real else rng.uniform(0, 0.25)) * d, 6))
    if all(abs(x) < d for x in effects):  # always give the demo something to find
        i = rng.randrange(len(factors))
        effects[i] = round(rng.choice([-1, 1]) * rng.uniform(1.4, 2.2) * d, 6)
    inter = {}
    for i, j in itertools.combinations(range(len(factors)), 2):
        inter[f"{i}{j}"] = round(rng.choice([-1, 1]) * rng.uniform(1.0, 1.6) * d, 6) if rng.random() < 0.35 else 0.0
    numeric = any(f["kind"] == "numeric" for f in factors)
    curvature = round(rng.choice([-1, 1]) * 0.9 * d, 6) if numeric and rng.random() < 0.25 else 0.0
    baseline = e["target"] if e["target"] is not None else 0.0
    return {"baseline": baseline, "noise": e["sigma"], "effects": effects, "interactions": inter, "curvature": curvature,
            "drift": round(rng.choice([0, 0, 0, 1]) * 0.8 * e["sigma"], 6)}


def _simulate_response(t: dict, xc: list[float], is_center: bool, frac: float, rng: random.Random) -> float:
    y = t["baseline"] + sum(eff / 2 * x for eff, x in zip(t["effects"], xc))
    for key, eff in t["interactions"].items():
        y += eff / 2 * xc[int(key[0])] * xc[int(key[1])]
    if is_center:
        y += t["curvature"]
    y += t["drift"] * frac
    return y + rng.gauss(0, t["noise"])


@router.post("/experiments/{eid}/simulate")
def simulate(eid: int):
    """Fill every open run with a simulated unit, confirmed settings (a few deviations) and a result."""
    e = _experiment(eid)
    _open(e)
    factors = _factors(eid)
    t = json.loads(e["sim_truth"]) if e["sim_truth"] else _truth(e, factors)
    runs = _runs(e, factors)
    ops = [r["operator_id"] for r in q("SELECT operator_id FROM mfg.operator")]
    rng = random.Random(f"sim-{eid}-{sum(1 for r in runs if r['serial'])}")
    numeric_idx = [i for i, f in enumerate(factors) if f["kind"] == "numeric"]
    todo = [r for r in runs if r["state"] != "measured"]
    n_dev = min(len(todo), max(1, round(0.1 * len(todo)))) if numeric_idx and len(todo) >= 6 else 0
    deviate = set(rng.sample([r["runNo"] for r in todo], n_dev)) if n_dev else set()
    stmts = [("UPDATE mfg.experiment SET sim_truth=%s, status='running' WHERE experiment_id=%s", (json.dumps(t), eid))]
    for r in todo:
        actual = list(r["planned"])
        note = None
        if r["runNo"] in deviate:
            i = rng.choice(numeric_idx)
            f = factors[i]
            actual[i] = round(actual[i] + rng.choice([-1, 1]) * rng.uniform(0.1, 0.25) * (f["high_value"] - f["low_value"]), 4)
            note = "Setpoint drifted during the run; actual value from the equipment log"
        xc = [_coded(f, v) for f, v in zip(factors, actual)]
        y = round(_simulate_response(t, xc, r["pointType"] == "center", r["runNo"] / len(runs), rng), 5)
        op = rng.choice(ops)
        a = actual + [None] * (3 - len(actual))
        if r["serial"]:
            stmts.append(("""UPDATE mfg.experiment_unit SET confirmed_by=ISNULL(confirmed_by,%s), confirmed_at=ISNULL(confirmed_at,SYSUTCDATETIME()),
                               as_planned=ISNULL(as_planned,%s), actual_1=ISNULL(actual_1,%s), actual_2=ISNULL(actual_2,%s),
                               actual_3=ISNULL(actual_3,%s), deviation_note=ISNULL(deviation_note,%s), response=%s, response_source='simulated'
                             WHERE experiment_id=%s AND run_no=%s""",
                          (op, note is None, a[0], a[1], a[2], note, y, eid, r["runNo"])))
        else:
            stmts.append(("""INSERT mfg.experiment_unit (experiment_id, run_no, serial, simulated, assigned_by, confirmed_by,
                               confirmed_at, as_planned, actual_1, actual_2, actual_3, deviation_note, response, response_source)
                             VALUES (%s,%s,%s,1,%s,%s,SYSUTCDATETIME(),%s,%s,%s,%s,%s,%s,'simulated')""",
                          (eid, r["runNo"], f"SIM{eid:04d}-{r['runNo']:02d}", op, op, note is None, a[0], a[1], a[2], note, y)))
    execute(stmts)
    return {"ok": True, "simulated": len(todo), "deviations": len(deviate)}


@router.post("/experiments/{eid}/reset-simulation")
def reset_simulation(eid: int):
    e = _experiment(eid)
    if e["status"] == "cancelled":
        raise HTTPException(409, "experiment is cancelled")
    execute([
        ("DELETE mfg.experiment_unit WHERE experiment_id=%s AND simulated=1", (eid,)),
        ("UPDATE mfg.experiment_unit SET response=NULL, response_source=NULL WHERE experiment_id=%s AND response_source='simulated'", (eid,)),
        ("""UPDATE mfg.experiment SET sim_truth=NULL, status=CASE WHEN EXISTS (SELECT 1 FROM mfg.experiment_unit
               WHERE experiment_id=%s) THEN 'running' ELSE 'planned' END WHERE experiment_id=%s""", (eid, eid)),
    ])
    return {"ok": True}


# --- analysis -------------------------------------------------------------------------------

def _classify(eff: float, lo: float, hi: float, p: float, alpha: float, delta: float) -> str:
    if p < alpha:
        return "real"
    if -delta < lo and hi < delta:
        return "none"
    return "unclear"


@router.get("/experiments/{eid}/analysis")
def analysis(eid: int):
    e = _experiment(eid)
    factors = _factors(eid)
    runs = _runs(e, factors)
    k = len(factors)
    names = [f["name"] for f in factors]
    alpha, delta = e["alpha"], e["effect_size"]
    done = [r for r in runs if r["response"] is not None]
    notes: list[dict] = []
    base = {"n": len(done), "planned": len(runs), "k": k}
    if len(done) < 2 ** k + 2:
        return {**base, "ready": False,
                "message": f"Need at least {2 ** k + 2} results to analyse; {len(done)} so far."}

    # model terms: mains, interactions, curvature (if centre points with numeric factors)
    X = np.array([r["actualCoded"] or r["x"] for r in done], dtype=float)
    y = np.array([r["response"] for r in done], dtype=float)
    is_center = np.array([r["pointType"] == "center" for r in done], dtype=float)
    terms: list[tuple[str, str, np.ndarray]] = [("Intercept", "intercept", np.ones(len(done)))]
    for i in range(k):
        terms.append((names[i], "main", X[:, i]))
    for i, j in itertools.combinations(range(k), 2):
        terms.append((f"{names[i]} × {names[j]}", "interaction", X[:, i] * X[:, j]))
    if k == 3:
        terms.append((" × ".join(names), "interaction3", X[:, 0] * X[:, 1] * X[:, 2]))
    if is_center.sum() > 0 and any(f["kind"] == "numeric" for f in factors):
        terms.append(("Curvature (middle vs corners)", "curvature", is_center))
    # drop the highest-order terms until there are at least 2 degrees of freedom for noise
    order = {"intercept": 0, "main": 1, "curvature": 2, "interaction": 3, "interaction3": 4}
    while len(done) - len(terms) < 2 and len(terms) > 1 + k:
        drop = max(range(len(terms)), key=lambda t: (order[terms[t][1]], t))
        notes.append({"level": "info", "text": f"Not enough results to estimate {terms[drop][0]}; left out of the model."})
        terms.pop(drop)
    M = np.column_stack([t[2] for t in terms])
    coef, *_ = np.linalg.lstsq(M, y, rcond=None)
    fitted = M @ coef
    resid = y - fitted
    df = len(done) - len(terms)
    s = float(math.sqrt(resid @ resid / df)) if df > 0 else float("nan")
    cov = s ** 2 * np.linalg.pinv(M.T @ M)
    tcrit = float(stats.t.ppf(1 - alpha / 2, df))

    model = []
    for (name, kind, _), b, var in zip(terms, coef, np.diag(cov)):
        se = math.sqrt(max(var, 0))
        scale = 1.0 if kind in ("intercept", "curvature") else 2.0   # effect = change from low to high
        eff, se_e = float(b) * scale, se * scale
        tval = eff / se_e if se_e > 0 else float("inf")
        p = float(2 * stats.t.sf(abs(tval), df))
        lo, hi = eff - tcrit * se_e, eff + tcrit * se_e
        model.append({"term": name, "kind": kind, "effect": eff, "se": se_e, "lo": lo, "hi": hi, "p": p,
                      "verdict": None if kind == "intercept" else _classify(eff, lo, hi, p, alpha, delta)})

    # plain-language headline per factor
    u = e["param_unit"] or ""
    headlines = []
    for i, f in enumerate(factors):
        m = model[1 + i]
        lo_lbl = f["low_label"] if f["kind"] == "categorical" else f"{f['low_value']:g} {f['units'] or ''}".strip()
        hi_lbl = f["high_label"] if f["kind"] == "categorical" else f"{f['high_value']:g} {f['units'] or ''}".strip()
        size = f"{m['effect']:+.3g} {u} (95% range {m['lo']:+.3g} to {m['hi']:+.3g})"
        text = {"real": f"{f['name']} has a real effect: going from {lo_lbl} to {hi_lbl} changes the result by {size}.",
                "none": f"{f['name']} makes no meaningful difference: any effect is smaller than {delta:g} {u}.",
                "unclear": f"{f['name']}: not enough evidence either way. Estimated change {size}; more units would settle it."}
        headlines.append({"factor": f["name"], "verdict": m["verdict"], "text": text[m["verdict"]]})
    for m in model:
        if m["kind"].startswith("interaction") and m["verdict"] == "real":
            headlines.append({"factor": m["term"], "verdict": "real",
                              "text": f"{m['term']} interact: the effect of one depends on the setting of the other ({m['effect']:+.3g} {u})."})
        if m["kind"] == "curvature" and m["verdict"] == "real":
            headlines.append({"factor": "Curvature", "verdict": "real",
                              "text": f"The middle setting is {m['effect']:+.3g} {u} away from a straight line between the corners: the relationship curves."})

    # observed means for main-effect and interaction plots (planned settings)
    def mean_ci(vals):
        n = len(vals)
        mu = float(np.mean(vals)) if n else None
        half = tcrit * s / math.sqrt(n) if n else None
        return {"n": n, "mean": mu, "lo": mu - half if n else None, "hi": mu + half if n else None}

    corners_done = [r for r in done if r["pointType"] == "corner"]
    main_plots = []
    for i, f in enumerate(factors):
        main_plots.append({"factor": f["name"], "low": mean_ci([r["response"] for r in corners_done if r["x"][i] < 0]),
                           "high": mean_ci([r["response"] for r in corners_done if r["x"][i] > 0])})
    inter_plots = []
    for i, j in itertools.combinations(range(k), 2):
        cells = {("L" if a < 0 else "H") + ("L" if b < 0 else "H"):
                 mean_ci([r["response"] for r in corners_done if r["x"][i] == a and r["x"][j] == b])
                 for a in (-1, 1) for b in (-1, 1)}
        inter_plots.append({"a": i, "b": j, "cells": cells})

    # predictions at every corner (and the middle), and the best one against target
    col = {t[0]: idx for idx, t in enumerate(terms)}
    def predict(xc, center=False):
        row = np.zeros(len(terms))
        row[0] = 1
        for i in range(k):
            if names[i] in col:
                row[col[names[i]]] = xc[i]
        for i, j in itertools.combinations(range(k), 2):
            nm = f"{names[i]} × {names[j]}"
            if nm in col:
                row[col[nm]] = xc[i] * xc[j]
        if k == 3 and " × ".join(names) in col:
            row[col[" × ".join(names)]] = xc[0] * xc[1] * xc[2]
        if center and "Curvature (middle vs corners)" in col:
            row[col["Curvature (middle vs corners)"]] = 1
        yhat = float(row @ coef)
        se = float(math.sqrt(max(row @ cov @ row, 0)))
        return yhat, yhat - tcrit * se, yhat + tcrit * se

    preds = []
    for combo in itertools.product((-1, 1), repeat=k):
        yhat, lo, hi = predict(list(combo))
        obs = [r["response"] for r in done if r["pointType"] == "corner" and r["x"] == list(combo)]
        preds.append({"x": list(combo), "pred": yhat, "lo": lo, "hi": hi, "observed": float(np.mean(obs)) if obs else None,
                      "n": len(obs), "inSpec": (e["lsl"] is None or lo >= e["lsl"]) and (e["usl"] is None or hi <= e["usl"])})
    target = e["target"]
    best = min(preds, key=lambda p_: abs(p_["pred"] - target)) if target is not None else max(preds, key=lambda p_: p_["pred"])
    centers = [r for r in done if r["pointType"] == "center"]
    center_obs = {}
    for r in centers:
        center_obs.setdefault(",".join(map(str, r["x"])), []).append(r["response"])

    # data-quality notes
    missing = len(runs) - len(done)
    if missing:
        notes.append({"level": "warn", "text": f"{missing} planned run{'s' if missing > 1 else ''} have no result yet."})
    devs = [r for r in done if r["asPlanned"] is False]
    if devs:
        notes.append({"level": "info", "text": f"{len(devs)} run{'s' if len(devs) > 1 else ''} used a different setting than planned "
                      f"(run {', '.join(str(r['runNo']) for r in devs)}). The analysis uses the settings actually run."})
    if s == s and df > 0:
        std = resid / s
        out = [done[i]["runNo"] for i in np.where(np.abs(std) > 3)[0]]
        if out:
            notes.append({"level": "warn", "text": f"Run {', '.join(map(str, out))} is far from the model (more than 3σ). Check for a measurement or handling problem."})
    if len(centers) >= 3:
        # drift: centre results against run order, after removing each categorical combination's mean
        adj = []
        for r in centers:
            grp = center_obs[",".join(map(str, r["x"]))]
            adj.append((r["runNo"], r["response"] - float(np.mean(grp))))
        if len({a for a, _ in adj}) >= 3:
            reg = stats.linregress([a for a, _ in adj], [b for _, b in adj])
            change = reg.slope * (len(runs) - 1)
            if reg.pvalue < 0.1 and abs(change) > s:
                notes.append({"level": "warn", "text": f"Middle-point results drifted by about {change:+.3g} {u} from the first run to the last. "
                              "Something changed over the experiment; treat the effects with caution."})
            else:
                notes.append({"level": "ok", "text": "Middle points were stable through the run order: no sign of drift."})
    corner_n = len(corners_done)
    achieved = float(stats.norm.cdf(delta / (2 * s / math.sqrt(corner_n)) - stats.norm.ppf(1 - alpha / 2))) if corner_n and s > 0 else None
    if s == s and s > 1.5 * e["sigma"]:
        notes.append({"level": "warn", "text": f"Noise in the experiment (σ = {s:.3g} {u}) was much higher than planned ({e['sigma']:.3g} {u})."})

    truth = None
    if e["sim_truth"]:
        t = json.loads(e["sim_truth"])
        truth = {"effects": [{"factor": names[i], "effect": v} for i, v in enumerate(t["effects"])],
                 "interactions": [{"term": f"{names[int(kk[0])]} × {names[int(kk[1])]}", "effect": v} for kk, v in t["interactions"].items()],
                 "curvature": t["curvature"], "drift": t["drift"], "noise": t["noise"]}

    return {
        **base, "ready": True, "df": df, "s": s, "r2": float(1 - (resid @ resid) / ((y - y.mean()) @ (y - y.mean()))) if len(y) > 1 else None,
        "achievedPower": achieved, "headlines": headlines, "model": model, "mainPlots": main_plots, "interactionPlots": inter_plots,
        "predictions": preds, "best": best, "centerMeans": {kk: float(np.mean(v)) for kk, v in center_obs.items()},
        "notes": notes, "truth": truth, "unit": u, "target": target, "lsl": e["lsl"], "usl": e["usl"],
        "residuals": [{"runNo": r["runNo"], "fitted": float(fv), "resid": float(rv), "pointType": r["pointType"]}
                      for r, fv, rv in zip(done, fitted, resid)],
    }
