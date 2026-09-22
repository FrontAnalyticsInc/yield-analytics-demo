"""Yield deep-dive API. Serves JSON under /api, inspection images, and the React build."""

import math
import os
from datetime import date, timedelta
from pathlib import Path

import pymssql
from fastapi import FastAPI, HTTPException, Query
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

IMAGE_DIR = Path(os.environ.get("IMAGE_DIR", "/data/images"))
STATIC_DIR = Path(os.environ.get("STATIC_DIR", "/app/static"))
EXPORT_DIR = Path(os.environ.get("EXPORT_DIR", "/data/exports"))
EXPORT_KEY = os.environ.get("EXPORT_KEY", "")

app = FastAPI(title="Yield Analytics API")


def connect():
    return pymssql.connect(server=os.environ.get("DB_HOST", "db"), user=os.environ.get("DB_USER", "sa"),
                           password=os.environ["DB_PASSWORD"], database="yield", as_dict=True)


def q(sql: str, params: tuple = ()) -> list[dict]:
    conn = connect()
    try:
        cur = conn.cursor()
        cur.execute(sql, params)
        return cur.fetchall()
    finally:
        conn.close()


def window(start: date | None, end: date | None) -> tuple[date, date]:
    end = end or date.today() + timedelta(days=1)
    return start or end - timedelta(days=365), end


# --- reference -----------------------------------------------------------------

@app.get("/api/health")
def health():
    return {"ok": True, "units": q("SELECT COUNT(*) n FROM mfg.unit")[0]["n"]}


@app.get("/api/meta")
def meta():
    return {
        "steps": q("SELECT * FROM mfg.step ORDER BY step_id"),
        "defects": q("SELECT * FROM mfg.defect"),
        "operators": q("SELECT * FROM mfg.operator ORDER BY operator_id"),
        "models": [r["model"] for r in q("SELECT DISTINCT model FROM mfg.unit ORDER BY model")],
        "lots": q("SELECT l.*, COUNT(u.serial) units FROM mfg.lot l LEFT JOIN mfg.unit u ON u.lot_id=l.lot_id "
                  "GROUP BY l.lot_id,l.tissue_lot,l.frame_lot,l.released_at ORDER BY l.released_at DESC"),
        "range": q("SELECT (SELECT MIN(started_at) FROM mfg.unit) first_start, "
                   "(SELECT MAX(ended_at) FROM mfg.step_event) last_event")[0],
    }


# --- yield -----------------------------------------------------------------------

@app.get("/api/summary")
def summary(start: date | None = None, end: date | None = None, model: str | None = None,
            grain: str = Query("month", enum=["month", "week"])):
    s, e = window(start, end)
    # period key: 'yyyy-MM' for months, the Monday (yyyy-MM-dd) for ISO-style weeks
    period = ("FORMAT(completed_at,'yyyy-MM')" if grain == "month" else
              "FORMAT(DATEADD(day, -((DATEPART(weekday, completed_at) + @@DATEFIRST - 2) % 7), "
              "CAST(completed_at AS DATE)),'yyyy-MM-dd')")
    m = model or "%"
    kpi = q("""
        SELECT COUNT(*) completed,
               SUM(CASE WHEN status='shipped' THEN 1 ELSE 0 END) shipped,
               SUM(CASE WHEN status='scrapped' THEN 1 ELSE 0 END) scrapped,
               SUM(CAST(first_pass AS INT)) first_pass,
               AVG(DATEDIFF(hour, started_at, completed_at) / 24.0) cycle_days
        FROM mfg.unit WHERE status<>'wip' AND completed_at>=%s AND completed_at<%s AND model LIKE %s""", (s, e, m))[0]
    wip = q("SELECT COUNT(*) n FROM mfg.unit WHERE status='wip' AND model LIKE %s", (m,))[0]["n"]
    steps = step_yield(start, end, model)
    rty = math.prod(r["fpy"] for r in steps if r["attempts"])
    trend = q(f"""
        SELECT {period} period, COUNT(*) completed,
               SUM(CASE WHEN status='shipped' THEN 1 ELSE 0 END) shipped,
               SUM(CASE WHEN status='scrapped' THEN 1 ELSE 0 END) scrapped,
               SUM(CAST(first_pass AS INT)) first_pass
        FROM mfg.unit WHERE status<>'wip' AND completed_at>=%s AND completed_at<%s AND model LIKE %s
        GROUP BY {period} ORDER BY period""", (s, e, m))
    if grain == "week":  # drop edge weeks with a handful of units; one scrap would read as 0% yield
        trend = [t for t in trend if t["completed"] >= 5]
    for t in trend:
        t["fpy"] = t["first_pass"] / t["completed"]
        t["final_yield"] = t["shipped"] / t["completed"]
    n = kpi["completed"] or 1
    return {**kpi, "wip": wip, "fpy": (kpi["first_pass"] or 0) / n, "final_yield": (kpi["shipped"] or 0) / n,
            "rty": rty, "trend": trend, "start": s, "end": e}


@app.get("/api/steps")
def step_yield(start: date | None = None, end: date | None = None, model: str | None = None):
    s, e = window(start, end)
    rows = q("""
        SELECT st.step_id, st.name, st.area, st.step_type,
               SUM(CASE WHEN ev.attempt=1 THEN 1 ELSE 0 END) attempts,
               SUM(CASE WHEN ev.attempt=1 AND ev.result<>'pass' THEN 1 ELSE 0 END) first_fail,
               SUM(CASE WHEN ev.result='rework' THEN 1 ELSE 0 END) rework,
               SUM(CASE WHEN ev.result='scrap' THEN 1 ELSE 0 END) scrap
        FROM mfg.step st
        LEFT JOIN mfg.step_event ev ON ev.step_id=st.step_id AND ev.ended_at>=%s AND ev.ended_at<%s
            AND ev.serial IN (SELECT serial FROM mfg.unit WHERE model LIKE %s)
        GROUP BY st.step_id, st.name, st.area, st.step_type ORDER BY st.step_id""", (s, e, model or "%"))
    for r in rows:
        r["fpy"] = 1 - r["first_fail"] / r["attempts"] if r["attempts"] else 1.0
    return rows


@app.get("/api/pareto")
def pareto(start: date | None = None, end: date | None = None, step_id: int | None = None):
    s, e = window(start, end)
    return q("""
        SELECT ev.defect_code, d.description, d.category, COUNT(*) n,
               SUM(CASE WHEN ev.result='scrap' THEN 1 ELSE 0 END) scrap
        FROM mfg.step_event ev JOIN mfg.defect d ON d.defect_code=ev.defect_code
        WHERE ev.ended_at>=%s AND ev.ended_at<%s AND (%s IS NULL OR ev.step_id=%s)
        GROUP BY ev.defect_code, d.description, d.category ORDER BY n DESC""", (s, e, step_id, step_id))


BREAKDOWN = {
    "operator": "ev.operator_id",
    "equipment": "ev.equipment_id",
    "lot": "u.lot_id",
    "tissue_lot": "l.tissue_lot",
    "model": "u.model",
    "month": "FORMAT(ev.ended_at,'yyyy-MM')",
}


@app.get("/api/breakdown")
def breakdown(dim: str = Query("operator", enum=list(BREAKDOWN)), step_id: int | None = None,
              area: str | None = None, start: date | None = None, end: date | None = None):
    s, e = window(start, end)
    col = BREAKDOWN[dim]
    rows = q(f"""
        SELECT {col} k, COUNT(*) attempts, SUM(CASE WHEN ev.result<>'pass' THEN 1 ELSE 0 END) fails
        FROM mfg.step_event ev JOIN mfg.step st ON st.step_id=ev.step_id
        JOIN mfg.unit u ON u.serial=ev.serial JOIN mfg.lot l ON l.lot_id=u.lot_id
        WHERE ev.attempt=1 AND ev.ended_at>=%s AND ev.ended_at<%s
          AND (%s IS NULL OR ev.step_id=%s) AND (%s IS NULL OR st.area=%s)
        GROUP BY {col} ORDER BY k""", (s, e, step_id, step_id, area, area))
    for r in rows:
        r["fail_rate"] = r["fails"] / r["attempts"] if r["attempts"] else 0
    return rows


@app.get("/api/spc/{step_id}")
def spc(step_id: int, start: date | None = None, end: date | None = None):
    s, e = window(start, end)
    step = q("SELECT * FROM mfg.step WHERE step_id=%s", (step_id,))
    if not step or step[0]["step_type"] != "measurement":
        raise HTTPException(404, "not a measurement step")
    pts = q("""
        SELECT ev.serial, ev.attempt, ev.ended_at t, ev.equipment_id, ev.operator_id, ev.result, m.value
        FROM mfg.step_event ev JOIN mfg.measurement m ON m.event_id=ev.event_id
        WHERE ev.step_id=%s AND ev.ended_at>=%s AND ev.ended_at<%s ORDER BY ev.ended_at""", (step_id, s, e))
    st = step[0]

    def stats(vals):
        if len(vals) < 2:
            return None
        mu = sum(vals) / len(vals)
        sd = math.sqrt(sum((v - mu) ** 2 for v in vals) / (len(vals) - 1))
        cp = (st["usl"] - st["lsl"]) / (6 * sd) if sd else None
        cpk = min(st["usl"] - mu, mu - st["lsl"]) / (3 * sd) if sd else None
        return {"n": len(vals), "mean": mu, "sd": sd, "cp": cp, "cpk": cpk}

    by_eq = {}
    for p in pts:
        by_eq.setdefault(p["equipment_id"], []).append(p["value"])
    first = [p["value"] for p in pts if p["attempt"] == 1]
    return {"step": st, "points": pts, "overall": stats(first),
            "by_equipment": {k: stats(v) for k, v in sorted(by_eq.items())}}


# --- images ------------------------------------------------------------------------

@app.get("/api/inspections")
def inspections(step_id: int | None = None, true_class: str | None = None, ai_class: str | None = None,
                mismatch: bool = False, lot: str | None = None, defects_only: bool = False,
                limit: int = Query(60, le=500), offset: int = 0):
    return q("""
        SELECT ev.event_id, ev.serial, ev.step_id, st.name step_name, ev.attempt, ev.ended_at, ev.operator_id,
               ev.equipment_id, ev.result, u.lot_id, l.tissue_lot, u.model,
               i.true_class, i.ai_class, i.ai_confidence, i.bbox_x, i.bbox_y, i.bbox_w, i.bbox_h
        FROM mfg.inspection_image i JOIN mfg.step_event ev ON ev.event_id=i.event_id
        JOIN mfg.step st ON st.step_id=ev.step_id JOIN mfg.unit u ON u.serial=ev.serial
        JOIN mfg.lot l ON l.lot_id=u.lot_id
        WHERE (%s IS NULL OR ev.step_id=%s) AND (%s IS NULL OR i.true_class=%s) AND (%s IS NULL OR i.ai_class=%s)
          AND (%s=0 OR i.true_class<>i.ai_class) AND (%s IS NULL OR u.lot_id=%s OR l.tissue_lot=%s)
          AND (%s=0 OR i.true_class<>'ok' OR i.ai_class<>'ok')
        ORDER BY ev.ended_at DESC OFFSET %s ROWS FETCH NEXT %s ROWS ONLY""",
             (step_id, step_id, true_class, true_class, ai_class, ai_class, int(mismatch), lot, lot, lot,
              int(defects_only), offset, limit))


@app.get("/api/inspections/confusion")
def confusion(step_id: int | None = None):
    return q("""
        SELECT i.true_class, i.ai_class, COUNT(*) n
        FROM mfg.inspection_image i JOIN mfg.step_event ev ON ev.event_id=i.event_id
        WHERE (%s IS NULL OR ev.step_id=%s) GROUP BY i.true_class, i.ai_class""", (step_id, step_id))


@app.get("/api/images/{event_id}.png")
def image(event_id: int):
    r = q("SELECT image_path FROM mfg.inspection_image WHERE event_id=%s", (event_id,))
    if not r:
        raise HTTPException(404)
    path = (IMAGE_DIR / r[0]["image_path"]).resolve()
    if IMAGE_DIR.resolve() not in path.parents or not path.exists():
        raise HTTPException(404)
    return FileResponse(path, media_type="image/png", headers={"Cache-Control": "public, max-age=86400"})


# --- Power BI feed ------------------------------------------------------------------

@app.get("/exports/{name}.parquet", include_in_schema=False)
def export_file(name: str, key: str = ""):
    """Parquet snapshots written by the exporter; Power BI Service refreshes from here."""
    if not EXPORT_KEY or key != EXPORT_KEY:
        raise HTTPException(403)
    f = EXPORT_DIR / f"{name}.parquet"
    if not name.replace("_", "").isalnum() or not f.exists():
        raise HTTPException(404)
    return FileResponse(f, media_type="application/vnd.apache.parquet")


# --- units -------------------------------------------------------------------------

@app.get("/api/units")
def units(search: str = "", status: str | None = None, lot: str | None = None, limit: int = Query(50, le=500)):
    return q("""
        SELECT TOP (%s) u.*, l.tissue_lot,
               (SELECT COUNT(*) FROM mfg.step_event ev WHERE ev.serial=u.serial AND ev.result<>'pass') issues,
               (SELECT MAX(step_id) FROM mfg.step_event ev WHERE ev.serial=u.serial) last_step
        FROM mfg.unit u JOIN mfg.lot l ON l.lot_id=u.lot_id
        WHERE u.serial LIKE %s AND (%s IS NULL OR u.status=%s) AND (%s IS NULL OR u.lot_id=%s)
        ORDER BY u.started_at DESC""", (limit, f"%{search}%", status, status, lot, lot))


@app.get("/api/units/{serial}")
def unit(serial: str):
    u = q("SELECT u.*, l.tissue_lot, l.frame_lot FROM mfg.unit u JOIN mfg.lot l ON l.lot_id=u.lot_id "
          "WHERE u.serial=%s", (serial,))
    if not u:
        raise HTTPException(404)
    events = q("""
        SELECT ev.*, st.name step_name, st.area, st.step_type, st.param_name, st.param_unit, st.lsl, st.target,
               st.usl, m.value, i.true_class, i.ai_class, i.ai_confidence, i.bbox_x, i.bbox_y, i.bbox_w, i.bbox_h,
               CASE WHEN i.event_id IS NULL THEN 0 ELSE 1 END has_image
        FROM mfg.step_event ev JOIN mfg.step st ON st.step_id=ev.step_id
        LEFT JOIN mfg.measurement m ON m.event_id=ev.event_id
        LEFT JOIN mfg.inspection_image i ON i.event_id=ev.event_id
        WHERE ev.serial=%s ORDER BY ev.started_at""", (serial,))
    return {**u[0], "events": events}


# --- design of experiments ------------------------------------------------------------

@app.get("/api/doe/noise/{step_id}")
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


@app.post("/api/experiments", status_code=201)
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


@app.get("/api/experiments")
def list_experiments():
    return q("""
        SELECT e.experiment_id, e.name, e.objective, e.status, e.created_at, e.created_by, o.name created_by_name,
               s.name response, (SELECT COUNT(*) FROM mfg.experiment_factor f WHERE f.experiment_id=e.experiment_id) factors,
               (SELECT COUNT(*) FROM mfg.experiment_run r WHERE r.experiment_id=e.experiment_id) runs
        FROM mfg.experiment e JOIN mfg.step s ON s.step_id=e.response_step_id JOIN mfg.operator o ON o.operator_id=e.created_by
        ORDER BY e.created_at DESC""")


@app.get("/api/experiments/{eid}")
def get_experiment(eid: int):
    e = q("""SELECT e.*, o.name created_by_name, s.name response, s.param_name, s.param_unit, s.lsl, s.target, s.usl
             FROM mfg.experiment e JOIN mfg.step s ON s.step_id=e.response_step_id
             JOIN mfg.operator o ON o.operator_id=e.created_by WHERE e.experiment_id=%s""", (eid,))
    if not e:
        raise HTTPException(404)
    factors = q("SELECT * FROM mfg.experiment_factor WHERE experiment_id=%s ORDER BY factor_no", (eid,))
    runs = q("SELECT * FROM mfg.experiment_run WHERE experiment_id=%s ORDER BY run_no", (eid,))
    k = len(factors)
    return {
        **e[0],
        "factors": [{"name": f["name"], "kind": f["kind"], "units": f["units"] or "", "low": f["low_value"] or 0,
                     "high": f["high_value"] or 0, "lowLabel": f["low_label"] or "", "highLabel": f["high_label"] or ""}
                    for f in factors],
        "runs": [{"runNo": r["run_no"], "pointType": r["point_type"], "replicate": r["replicate"],
                  "x": [r["x1"], r["x2"], r["x3"]][:k]} for r in runs],
    }


# --- React build (must be last) --------------------------------------------------------

if STATIC_DIR.exists():
    app.mount("/assets", StaticFiles(directory=STATIC_DIR / "assets"), name="assets")

    @app.get("/{path:path}", include_in_schema=False)
    def spa(path: str):
        f = (STATIC_DIR / path).resolve()
        if path and STATIC_DIR.resolve() in f.parents and f.is_file():
            return FileResponse(f)
        return FileResponse(STATIC_DIR / "index.html")
