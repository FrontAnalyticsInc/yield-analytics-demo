"""Deterministic production simulator.

Every unit's full route is a pure function of (SEED, unit index), so the
simulator can be re-run at any time: it replays the plan and inserts only the
events whose end time has passed. That gives a backfill on first start and a
live trickle of new production afterwards, with no state outside the database.

Built-in stories for the demo (all visible in the analytics):
  * Wireform diameter station MS-15-2 drifts high from mid-May to early July 2026.
  * Tissue lot PT-2606-B carries elevated calcific spots.
  * New hire OP-07 (swing shift, started March 2026) has a suture learning curve.
  * The vision model under-calls fiber/particulate, so AI vs inspector disagree.
  * The pressure integrity test (step 39) fails 40% of valves and the retest recovers
    well under half of them, so rework is expensive and mostly ineffective.
"""

import argparse
import logging
import math
import os
import random
import re
import time
from datetime import datetime, timedelta

import pymssql

import images
from routing import (DEFECTS, GATES, MODELS, OPERATORS, SCAN_CLASSES, SCAN_LIMITS, SCRAP_DEFECTS, STEP_ID,
                     STEPS, VISUAL_DEFECTS, equipment_for)

log = logging.getLogger("sim")
SEED = int(os.environ.get("SIM_SEED", "2026"))
EPOCH = datetime.fromisoformat(os.environ.get("SIM_EPOCH", "2025-10-01T06:00:00"))
UNITS_PER_MONTH = float(os.environ.get("SIM_UNITS_PER_MONTH", "100"))
IMAGE_DIR = os.environ.get("IMAGE_DIR", "/data/images")
UNITS_PER_LOT = 20
START_INTERVAL = timedelta(days=30.4 / UNITS_PER_MONTH)


def connect(database="yield"):
    return pymssql.connect(
        server=os.environ.get("DB_HOST", "db"),
        user=os.environ.get("DB_USER", "sa"),
        password=os.environ["DB_PASSWORD"],
        database=database,
        autocommit=True,
    )


def apply_schema():
    sql = open(os.path.join(os.path.dirname(__file__), "schema.sql")).read()
    conn = connect("master")
    cur = conn.cursor()
    for batch in re.split(r"^\s*GO\s*$", sql, flags=re.M):
        if batch.strip():
            cur.execute(batch)
    conn.close()


def seed_reference(cur):
    cur.execute("SELECT COUNT(*) FROM mfg.step")
    if cur.fetchone()[0]:
        return
    for i, (name, area, kind, spec) in enumerate(STEPS, 1):
        p = spec or (None, None, None, None, None, None)
        cur.execute(
            "INSERT mfg.step VALUES (%d,%s,%s,%s,%s,%s,%s,%s,%s)",
            (i, name, area, kind, p[0], p[1], p[2], p[3], p[4]),
        )
        for eq_id, eq_name in equipment_for(i, kind):
            cur.execute("INSERT mfg.equipment VALUES (%s,%d,%s)", (eq_id, i, eq_name))
    cur.executemany("INSERT mfg.defect VALUES (%s,%s,%s)", DEFECTS)
    cur.executemany("INSERT mfg.operator VALUES (%s,%s,%s,%s)", OPERATORS)


# --- effects -----------------------------------------------------------------

def drift(eq_id: str, t: datetime) -> float:
    """Mean shift (in process SDs) for a station at time t."""
    if eq_id == f'MS-{STEP_ID["Wireform diameter check"]:02d}-2':
        start, peak, fixed = datetime(2026, 5, 15), datetime(2026, 6, 25), datetime(2026, 7, 6)
        if start <= t < fixed:
            return 4.6 * min(1.0, (t - start) / (peak - start))
    if eq_id == f'MS-{STEP_ID["Effective orifice area"]:02d}-1':  # slow, harmless wander so charts aren't flat
        return 0.4 * math.sin((t - EPOCH).days / 45)
    return 0.0


def lot_ids(i: int):
    n = i // UNITS_PER_LOT
    released = EPOCH + START_INTERVAL * n * UNITS_PER_LOT - timedelta(days=2)
    tag = released.strftime("%y%m")
    k = "ABCDEFGH"[(n % 5)]
    return f"L{released:%y%m}-{n:03d}", f"PT-{tag}-{k}", f"WF-{tag}-{n % 3 + 1}", released


def operator_skill(op_id: str, t: datetime) -> float:
    """Multiplier on suture/assembly defect rates."""
    if op_id == "OP-07":
        months = max(0.0, (t - datetime(2026, 3, 2)).days / 30)
        return 1 + 5.0 * math.exp(-months / 2.2)
    return 1.0


# --- plan ----------------------------------------------------------------------

def plan_unit(i: int):
    """Full deterministic route for unit i: (unit dict, [events])."""
    rng = random.Random(f"{SEED}-{i}")
    start = EPOCH + START_INTERVAL * i + timedelta(minutes=rng.uniform(-90, 90))
    lot_id, tissue_lot, _, _ = lot_ids(i)
    bad_tissue = tissue_lot.startswith("PT-2606") and tissue_lot.endswith("B")
    unit = dict(serial=f"HV{start:%y}{i:05d}", lot_id=lot_id, model=rng.choice(MODELS),
                started_at=start, completed_at=None, status="shipped", first_pass=True)
    events, t = [], start
    for step_id, (name, area, kind, spec) in enumerate(STEPS, 1):
        stations = equipment_for(step_id, kind)
        attempt = 1
        while True:
            t += timedelta(hours=rng.expovariate(1 / 3.5))            # queue
            if t.weekday() >= 5:                                        # no weekend shifts
                t += timedelta(days=7 - t.weekday())
            dur = timedelta(minutes=rng.uniform(10, 50) * (2 if area == "Test" and kind in ("measurement", "gate") else 1))
            shift_ops = [o for o in OPERATORS if o[2] == ("day" if 6 <= t.hour < 15 else "swing")]
            op = rng.choice(shift_ops)[0]
            eq = rng.choice(stations)[0]
            ev = dict(serial=unit["serial"], step_id=step_id, attempt=attempt, started_at=t, ended_at=t + dur,
                      operator_id=op, equipment_id=eq, result="pass", defect_code=None, value=None, image=None,
                      scan=None)
            t += dur

            if kind == "measurement":
                p, _, lsl, tgt, usl, sd = spec
                # a rework re-measures after adjustment, so most of the drift is taken out
                mu = tgt + drift(eq, t) * sd * (0.2 if attempt > 1 else 1)
                v = rng.gauss(mu, sd)
                ev["value"] = round(v, 4)
                if v < lsl or v > usl:
                    ev["defect_code"] = "OOS_LOW" if v < lsl else "OOS_HIGH"
                    ev["result"] = "rework" if attempt == 1 else "scrap"
            elif kind == "visual":
                rate = 0.035
                cands = VISUAL_DEFECTS[step_id]
                weights = [1.0] * len(cands)
                if bad_tissue and "CALCIFIC_SPOT" in cands:
                    rate += 0.3
                    weights[cands.index("CALCIFIC_SPOT")] = 6
                if step_id in (STEP_ID["Suture line inspection"], STEP_ID["Coaptation visual check"]):
                    rate *= operator_skill(op, t)
                if attempt > 1:
                    rate *= 0.3
                defect = rng.choices(cands, weights)[0] if rng.random() < rate else None
                ev["image"] = image_meta(rng, step_id, defect)
                if defect:
                    ev["defect_code"] = defect
                    ev["result"] = "scrap" if defect in SCRAP_DEFECTS or attempt > 1 else "rework"
            elif kind == "scan":
                ev["scan"] = scan_meta(rng, bad_tissue, attempt)
                if ev["scan"]["reject"]:
                    ev["defect_code"] = "INCLUSION_EXCESS"
                    # a reject goes back for re-clean and re-scan; a second reject is scrap
                    ev["result"] = "rework" if attempt == 1 else "scrap"
            elif kind == "gate":
                # go / no-go: pass or fail, nothing measured. A failed unit is reworked once;
                # the retest fails far more often than the first test, so rework recovers little.
                first, retest, defect = GATES[step_id]
                rate = first if attempt == 1 else retest
                if step_id == STEP_ID["Coaptation go / no-go"]:
                    rate *= operator_skill(op, t)
                if rng.random() < rate:
                    ev["defect_code"] = defect
                    ev["result"] = "rework" if attempt == 1 else "scrap"
            else:
                rate = 0.0015 * (operator_skill(op, t) if area == "Assembly" else 1)
                if rng.random() < rate:
                    ev["defect_code"] = "PROCESS_DEV"
                    ev["result"] = "rework" if attempt == 1 else "scrap"

            events.append(ev)
            if ev["result"] != "pass":
                unit["first_pass"] = False
            if ev["result"] == "rework":
                attempt += 1
                continue
            break
        if events[-1]["result"] == "scrap":
            unit["status"] = "scrapped"
            break
    unit["completed_at"] = events[-1]["ended_at"]
    return unit, events


def scan_meta(rng, bad_tissue, attempt):
    """Transillumination scan: every inclusion the vision system finds, plus the verdict.

    The rule is count-and-size, so a scan can reject on many small hits or on one big one.
    Re-cleaning removes most loose particulate, so a rescan usually comes back clean.
    """
    mu = 9.5 + (5.5 if bad_tissue else 0)
    n = max(0, int(rng.gauss(mu * (0.45 if attempt > 1 else 1), 3.2)))
    dets = []
    for k in range(n):
        cls = rng.choices(SCAN_CLASSES, [5, 4, 2, 2])[0]
        size = round(math.exp(rng.gauss(math.log(0.2 if cls == "INCLUSION" else 0.15), 0.45)), 3)
        w = min(0.16, max(0.035, size / 3))
        # place the hit inside the lit leaflet, not on the dark table around it: the two
        # uniforms become an angle and a radius on the ellipse the backlit cusp fills
        ang, rad = 2 * math.pi * rng.random(), math.sqrt(rng.random())
        x = 0.5 + 0.27 * rad * math.cos(ang) - w / 2
        y = 0.50 + 0.17 * rad * math.sin(ang) - w / 2
        dets.append(dict(idx=k + 1, cls=cls, size_mm=size, confidence=round(rng.uniform(0.55, 0.99), 3),
                         bbox_x=round(x, 4), bbox_y=round(y, 4), bbox_w=round(w, 4), bbox_h=round(w, 4)))
    biggest = max((d["size_mm"] for d in dets), default=0.0)
    rule = n > SCAN_LIMITS["count"] or biggest > SCAN_LIMITS["size_mm"]
    # the inspector reviews the boxes and occasionally overrides a borderline call
    borderline = abs(n - SCAN_LIMITS["count"]) <= 2 or abs(biggest - SCAN_LIMITS["size_mm"]) < 0.04
    reject = (not rule) if (borderline and rng.random() < 0.25) else rule
    return dict(dets=dets, count=n, max_mm=biggest, reject=reject, rule=rule)


def image_meta(rng, step_id, defect):
    """Truth + a vision-model prediction with realistic mistakes."""
    truth = defect or "ok"
    r = rng.random()
    if truth == "FIBER_PARTICLE" and r < 0.35:
        ai, conf = "ok", rng.uniform(0.55, 0.8)                 # model misses faint fibers
    elif truth == "ok" and r < 0.02:
        ai, conf = rng.choice(VISUAL_DEFECTS[step_id]), rng.uniform(0.5, 0.7)   # false positive
    else:
        ai, conf = truth, rng.uniform(0.82, 0.995)
    return dict(true_class=truth, ai_class=ai, ai_confidence=round(conf, 3), seed=rng.randrange(2**31))


# --- sync ----------------------------------------------------------------------

def insert_rows(cur, table, cols, rows, batch=400):
    if not rows:
        return
    ph = "(" + ",".join(["%s"] * len(cols)) + ")"
    for k in range(0, len(rows), batch):
        chunk = rows[k:k + batch]
        cur.execute(f"INSERT {table} ({','.join(cols)}) VALUES " + ",".join([ph] * len(chunk)),
                    tuple(v for row in chunk for v in row))


def sync(now: datetime):
    conn = connect()
    cur = conn.cursor()
    seed_reference(cur)
    cur.execute("SELECT serial, status FROM mfg.unit")
    units = dict(cur.fetchall())
    cur.execute("SELECT serial, step_id, attempt FROM mfg.step_event")
    have = {tuple(r) for r in cur.fetchall()}
    cur.execute("SELECT lot_id FROM mfg.lot")
    lots = {r[0] for r in cur.fetchall()}
    cur.execute("SELECT ISNULL(MAX(event_id),0) FROM mfg.step_event")
    next_id = cur.fetchone()[0] + 1

    new_lots, new_units, new_events, meas, imgs, dets, updates = [], [], [], [], [], [], []
    i = 0
    while EPOCH + START_INTERVAL * i <= now:
        unit, events = plan_unit(i)
        lot_id, tissue, frame, released = lot_ids(i)
        i += 1
        if unit["started_at"] > now:
            continue
        if lot_id not in lots:
            lots.add(lot_id)
            new_lots.append((lot_id, tissue, frame, released))
        done = unit["completed_at"] <= now
        if unit["serial"] not in units:
            new_units.append((unit["serial"], unit["lot_id"], unit["model"], unit["started_at"],
                              unit["completed_at"] if done else None, unit["status"] if done else "wip",
                              unit["first_pass"] if done else None))
        elif done and units[unit["serial"]] == "wip":
            updates.append((unit["completed_at"], unit["status"], unit["first_pass"], unit["serial"]))
        for ev in events:
            if ev["ended_at"] > now or (ev["serial"], ev["step_id"], ev["attempt"]) in have:
                continue
            eid = next_id
            next_id += 1
            new_events.append((eid, ev["serial"], ev["step_id"], ev["attempt"], ev["started_at"], ev["ended_at"],
                               ev["operator_id"], ev["equipment_id"], ev["result"], ev["defect_code"]))
            if ev["value"] is not None:
                meas.append((eid, ev["value"]))
            if ev["scan"]:
                sc = ev["scan"]
                rel = f"{ev['serial']}/{ev['step_id']:02d}-{ev['attempt']}.png"
                os.makedirs(os.path.join(IMAGE_DIR, ev["serial"]), exist_ok=True)
                images.transillumination(random.Random(f"{SEED}-scan-{eid}"), sc["dets"], os.path.join(IMAGE_DIR, rel))
                verdict = "INCLUSION_EXCESS" if sc["reject"] else "ok"
                imgs.append((eid, rel, verdict, "INCLUSION_EXCESS" if sc["rule"] else "ok",
                             round(min(0.99, 0.6 + abs(sc["count"] - SCAN_LIMITS["count"]) / 30), 3),
                             *(None,) * 4))
                dets += [(eid, d["idx"], d["cls"], d["size_mm"], d["confidence"],
                          d["bbox_x"], d["bbox_y"], d["bbox_w"], d["bbox_h"]) for d in sc["dets"]]
            if ev["image"]:
                im = ev["image"]
                rel = f"{ev['serial']}/{ev['step_id']:02d}-{ev['attempt']}.png"
                os.makedirs(os.path.join(IMAGE_DIR, ev["serial"]), exist_ok=True)
                truth = None if im["true_class"] == "ok" else im["true_class"]
                bbox = images.render(ev["step_id"], truth, random.Random(im["seed"]), os.path.join(IMAGE_DIR, rel))
                imgs.append((eid, rel, im["true_class"], im["ai_class"], im["ai_confidence"], *(bbox or (None,) * 4)))

    insert_rows(cur, "mfg.lot", ["lot_id", "tissue_lot", "frame_lot", "released_at"], new_lots)
    insert_rows(cur, "mfg.unit", ["serial", "lot_id", "model", "started_at", "completed_at", "status", "first_pass"], new_units)
    for u in updates:
        cur.execute("UPDATE mfg.unit SET completed_at=%s, status=%s, first_pass=%s WHERE serial=%s", u)
    insert_rows(cur, "mfg.step_event", ["event_id", "serial", "step_id", "attempt", "started_at", "ended_at",
                                        "operator_id", "equipment_id", "result", "defect_code"], new_events)
    insert_rows(cur, "mfg.measurement", ["event_id", "value"], meas)
    insert_rows(cur, "mfg.inspection_image", ["event_id", "image_path", "true_class", "ai_class", "ai_confidence",
                                              "bbox_x", "bbox_y", "bbox_w", "bbox_h"], imgs, batch=200)
    insert_rows(cur, "mfg.inspection_detection", ["event_id", "idx", "class", "size_mm", "confidence",
                                                  "bbox_x", "bbox_y", "bbox_w", "bbox_h"], dets, batch=300)
    conn.close()
    log.info("sync @ %s: +%d units, %d completed, +%d events, +%d images, +%d detections",
             now.isoformat(timespec="minutes"), len(new_units), len(updates), len(new_events),
             len(imgs), len(dets))


def main():
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(message)s")
    ap = argparse.ArgumentParser()
    ap.add_argument("--once", action="store_true")
    ap.add_argument("--interval", type=int, default=int(os.environ.get("SIM_INTERVAL_SECONDS", "900")))
    args = ap.parse_args()
    for attempt in range(60):
        try:
            apply_schema()
            break
        except pymssql.Error as e:
            log.info("waiting for database (%s)", str(e)[:80])
            time.sleep(5)
    else:
        raise SystemExit("database never came up")
    while True:
        sync(datetime.now().replace(microsecond=0))
        if args.once:
            return
        time.sleep(args.interval)


if __name__ == "__main__":
    main()
