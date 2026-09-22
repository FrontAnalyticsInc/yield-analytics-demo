"""Yield deep-dive API. Serves JSON under /api, inspection images, and the React build."""

import math
import os
from datetime import date, timedelta
from pathlib import Path

import pymssql
from fastapi import FastAPI, HTTPException, Query
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

IMAGE_DIR = Path(os.environ.get("IMAGE_DIR", "/data/images"))
STATIC_DIR = Path(os.environ.get("STATIC_DIR", "/app/static"))
EXPORT_DIR = Path(os.environ.get("EXPORT_DIR", "/data/exports"))
EXPORT_KEY = os.environ.get("EXPORT_KEY", "")

app = FastAPI(title="Yield Analytics API")


def q(sql: str, params: tuple = ()) -> list[dict]:
    conn = pymssql.connect(server=os.environ.get("DB_HOST", "db"), user=os.environ.get("DB_USER", "sa"),
                           password=os.environ["DB_PASSWORD"], database="yield", as_dict=True)
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


# --- React build (must be last) --------------------------------------------------------

if STATIC_DIR.exists():
    app.mount("/assets", StaticFiles(directory=STATIC_DIR / "assets"), name="assets")

    @app.get("/{path:path}", include_in_schema=False)
    def spa(path: str):
        f = (STATIC_DIR / path).resolve()
        if path and STATIC_DIR.resolve() in f.parents and f.is_file():
            return FileResponse(f)
        return FileResponse(STATIC_DIR / "index.html")
