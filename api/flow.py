"""Process flow: the whole routing as a funnel, showing where units are scrapped or reworked.

Cohort = units that finished (shipped or scrapped) in the window, so every unit has a
complete path and the band only narrows where units actually leave.

Defects are *caught* at checks (measurement, visual and go/no-go steps) but *caused* upstream.
ORIGIN is engineering's attribution of (defect, catching step) -> causing step. It is an
assumption table, not a measurement; the UI labels it as such.
"""

import math
from datetime import date, timedelta

from fastapi import APIRouter

from db import q

router = APIRouter()

# (defect_code, step that caught it) -> step most likely to have caused it
ORIGIN = {
    ("TISSUE_TEAR", 1): 1,           # arrives torn: supplier / harvest
    ("CALCIFIC_SPOT", 1): 1,
    ("FIBER_PARTICLE", 1): 1,
    ("TISSUE_TEAR", 10): 8,          # die cutting nicks the leaflet edge
    ("CALCIFIC_SPOT", 10): 6,        # anti-calcification treatment not effective
    ("FIBER_PARTICLE", 10): 8,
    ("SUTURE_GAP", 25): 24,
    ("FIBER_PARTICLE", 25): 23,
    ("SUTURE_GAP", 30): 24,
    ("LEAFLET_MISALIGN", 30): 22,    # leaflet-to-frame alignment
    ("TISSUE_TEAR", 44): 24,         # needle damage during leaflet body suturing
    ("SUTURE_GAP", 44): 24,
    ("LEAFLET_MISALIGN", 44): 22,
    ("FIBER_PARTICLE", 44): 28,      # trimming sheds fabric fibers
    ("COAPT_FAIL", 31): 22,          # go / no-go: geometry set at leaflet-to-frame alignment
    ("LEAK_FAIL", 39): 24,           # go / no-go: a leak path is a suture line problem
}


def origin(defect: str | None, step_id: int, process_steps: list[int]) -> int:
    if (defect, step_id) in ORIGIN:
        return ORIGIN[(defect, step_id)]
    if defect in ("OOS_LOW", "OOS_HIGH", "FIBER_PARTICLE"):
        before = [s for s in process_steps if s < step_id]
        return before[-1] if before else step_id
    return step_id  # process deviations happen where they are recorded


@router.get("/api/flow")
def flow(start: date | None = None, end: date | None = None, model: str | None = None):
    end = end or date.today() + timedelta(days=1)
    start = start or end - timedelta(days=365)
    cohort = """SELECT serial FROM mfg.unit WHERE status<>'wip' AND completed_at>=%s AND completed_at<%s
                AND model LIKE %s"""
    args = (start, end, model or "%")
    steps = q("SELECT step_id, name, area, step_type, param_name, param_unit, lsl, target, usl "
              "FROM mfg.step ORDER BY step_id")
    units = q(f"SELECT COUNT(*) n FROM ({cohort}) c", args)[0]["n"]
    events = q(f"""
        SELECT step_id, result, defect_code, COUNT(*) n,
               SUM(CASE WHEN attempt=1 THEN 1 ELSE 0 END) first
        FROM mfg.step_event WHERE result<>'pass' AND serial IN ({cohort})
        GROUP BY step_id, result, defect_code""", args)
    # capability at measurement gates (first attempts only, like the SPC page)
    cap = {r["step_id"]: r for r in q(f"""
        SELECT ev.step_id, COUNT(*) n, AVG(m.value) mean, STDEV(m.value) sd
        FROM mfg.step_event ev JOIN mfg.measurement m ON m.event_id=ev.event_id
        WHERE ev.attempt=1 AND ev.serial IN ({cohort}) GROUP BY ev.step_id""", args)}
    # inspector vs vision-model agreement at visual gates
    ai = {r["step_id"]: r for r in q(f"""
        SELECT ev.step_id, COUNT(*) n, SUM(CASE WHEN i.true_class=i.ai_class THEN 1 ELSE 0 END) agree
        FROM mfg.inspection_image i JOIN mfg.step_event ev ON ev.event_id=i.event_id
        WHERE ev.serial IN ({cohort}) GROUP BY ev.step_id""", args)}

    process_steps = [s["step_id"] for s in steps if s["step_type"] == "process"]
    by_step = {s["step_id"]: {**s, "scrap": {}, "rework": {}, "first_fail": 0,
                              "caused_scrap": {}, "caused_rework": {}} for s in steps}
    for e in events:
        st = by_step[e["step_id"]]
        st[e["result"]][e["defect_code"]] = st[e["result"]].get(e["defect_code"], 0) + e["n"]
        st["first_fail"] += e["first"]
        o = by_step[origin(e["defect_code"], e["step_id"], process_steps)]
        bucket = o["caused_" + e["result"]]
        key = f'{e["defect_code"]}@{e["step_id"]}'   # keep where it was caught, for the tooltip
        bucket[key] = bucket.get(key, 0) + e["n"]

    remaining = units
    out = []
    for s in steps:
        st = by_step[s["step_id"]]
        st["entered"] = remaining
        remaining -= sum(st["scrap"].values())
        st["fpy"] = 1 - st["first_fail"] / st["entered"] if st["entered"] else 1.0
        c = cap.get(s["step_id"])
        st["cpk"] = (min(s["usl"] - c["mean"], c["mean"] - s["lsl"]) / (3 * c["sd"])
                     if c and c["sd"] and s["usl"] is not None else None)
        a = ai.get(s["step_id"])
        st["ai_agreement"] = a["agree"] / a["n"] if a and a["n"] else None
        st["images"] = a["n"] if a else 0
        out.append(st)
    shipped = remaining
    return {"units": units, "shipped": shipped, "yield": shipped / units if units else None,
            "rty": math.prod(s["fpy"] for s in out if s["entered"]), "steps": out,
            "start": start, "end": end}
