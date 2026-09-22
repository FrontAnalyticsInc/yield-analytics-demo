"""The 53-step routing for a bovine-pericardium surgical heart valve.

Each step is (name, area, type, spec). Measurement specs are
(param, unit, lsl, target, usl, process_sd). Visual steps capture an image.
Base fail rates are per attempt; the simulator layers drift and lot/operator
effects on top.
"""

P, M, V, G, T = "process", "measurement", "visual", "gate", "scan"
# V = one image, one disposition. T = transillumination scan: the leaflet is backlit and the
# vision system boxes every inclusion it finds, so accept / reject is a count-and-size rule.
# G = go / no-go, pass or fail, nothing measured.

STEPS = [
    # Tissue preparation
    ("Pericardium receiving inspection", "Tissue", V, None),
    ("Tissue rinse & cleaning", "Tissue", P, None),
    ("Glutaraldehyde fixation", "Tissue", P, None),
    ("Fixation pH check", "Tissue", M, ("ph", "pH", 7.2, 7.4, 7.6, 0.06)),
    ("Tissue thickness mapping", "Tissue", M, ("thickness", "mm", 0.30, 0.375, 0.45, 0.018)),
    ("Anti-calcification treatment", "Tissue", P, None),
    ("Tissue lot release review", "Tissue", P, None),
    ("Leaflet die cutting", "Leaflet", P, None),
    ("Leaflet width measurement", "Leaflet", M, ("leaflet_width", "mm", 21.8, 22.0, 22.2, 0.045)),
    ("Leaflet visual inspection", "Leaflet", V, None),
    ("Leaflet transillumination scan", "Leaflet", T, None),
    ("Leaflet matching (triplet)", "Leaflet", P, None),
    ("Leaflet deflection test", "Leaflet", M, ("deflection", "mm", 3.2, 3.6, 4.0, 0.09)),
    # Frame / stent
    ("Wireform receiving", "Frame", P, None),
    ("Wireform forming", "Frame", P, None),
    ("Wireform diameter check", "Frame", M, ("wireform_dia", "mm", 22.90, 23.00, 23.10, 0.024)),
    ("Stent post height check", "Frame", M, ("post_height", "mm", 14.8, 15.0, 15.2, 0.045)),
    ("Frame passivation", "Frame", P, None),
    ("Fabric covering of wireform", "Frame", P, None),
    ("Sewing ring molding", "Frame", P, None),
    ("Sewing ring durometer", "Frame", M, ("durometer", "Shore A", 45, 50, 55, 1.1)),
    ("Frame subassembly inspection", "Frame", P, None),
    # Sewing / assembly
    ("Leaflet-to-frame alignment", "Assembly", P, None),
    ("Commissure suturing", "Assembly", P, None),
    ("Leaflet body suturing", "Assembly", P, None),
    ("Suture line inspection", "Assembly", V, None),
    ("Sewing ring attachment", "Assembly", P, None),
    ("Suture tension check", "Assembly", M, ("suture_tension", "N", 1.8, 2.2, 2.6, 0.09)),
    ("Trim excess fabric", "Assembly", P, None),
    ("Commissure height measurement", "Assembly", M, ("commissure_height", "mm", 13.6, 14.0, 14.4, 0.08)),
    ("Coaptation visual check", "Assembly", V, None),
    ("Coaptation go / no-go", "Assembly", G, None),
    ("Valve ID marking", "Assembly", P, None),
    # Functional test
    ("Pre-test rinse", "Test", P, None),
    ("Hydrodynamic test setup", "Test", P, None),
    ("Effective orifice area", "Test", M, ("eoa", "cm2", 1.60, 1.85, 2.10, 0.055)),
    ("Mean pressure gradient", "Test", M, ("gradient", "mmHg", 6.0, 9.0, 12.0, 0.7)),
    ("Regurgitant fraction", "Test", M, ("regurgitant_fraction", "%", 0.0, 4.0, 10.0, 1.4)),
    ("Leakage test", "Test", M, ("leakage", "mL/s", 0.0, 1.0, 2.5, 0.35)),
    ("Pressure integrity test", "Test", G, None),
    ("Leaflet opening dynamics review", "Test", P, None),
    ("Post-test rinse", "Test", P, None),
    # Final
    ("Bioburden sampling", "Final", P, None),
    ("Final dimensional check", "Final", M, ("final_od", "mm", 29.70, 30.00, 30.30, 0.07)),
    ("Final visual inspection", "Final", V, None),
    ("Holder attachment", "Final", P, None),
    ("Jar fill (storage solution)", "Final", P, None),
    ("Jar seal & torque", "Final", M, ("cap_torque", "N·m", 1.1, 1.3, 1.5, 0.045)),
    ("Terminal sterilization", "Final", P, None),
    ("Sterility indicator review", "Final", P, None),
    ("Labeling", "Final", P, None),
    ("Device history record review", "Final", P, None),
    ("Final QA release", "Final", P, None),
]
assert len(STEPS) == 53

# Steps are looked up by name everywhere below, so inserting a step into the route
# never silently repoints one of these tables at its neighbour.
STEP_ID = {name: i for i, (name, *_) in enumerate(STEPS, 1)}
assert len(STEP_ID) == len(STEPS), "step names must be unique"


def ids(by_name: dict) -> dict:
    return {STEP_ID[k]: v for k, v in by_name.items()}


# Go / no-go gates: (fail rate on first attempt, fail rate on the retest, defect).
# The pressure test is the dominant loss: 38% fail, and most of those cannot be recovered,
# which is what makes rework look ineffective (~59% pass first time, ~75% after rework).
GATES = ids({
    "Coaptation go / no-go": (0.07, 0.25, "COAPT_FAIL"),
    "Pressure integrity test": (0.38, 0.58, "LEAK_FAIL"),
})

DEFECTS = [
    # code, description, category
    ("TISSUE_TEAR", "Tear or nick in leaflet tissue", "tissue"),
    ("CALCIFIC_SPOT", "Calcific / mineral deposit on tissue", "tissue"),
    ("FIBER_PARTICLE", "Foreign fiber or particulate", "tissue"),
    ("SUTURE_GAP", "Missing or skipped suture", "suture"),
    ("LEAFLET_MISALIGN", "Leaflet coaptation misalignment", "suture"),
    ("OOS_LOW", "Measurement below LSL", "dimensional"),
    ("OOS_HIGH", "Measurement above USL", "dimensional"),
    ("PROCESS_DEV", "Process deviation / documentation error", "process"),
    ("COAPT_FAIL", "Coaptation gap at go / no-go check", "functional"),
    ("LEAK_FAIL", "Leak beyond limit at pressure integrity test", "functional"),
    ("INCLUSION_EXCESS", "Too many or too large inclusions in transillumination scan", "tissue"),
]

# Which image defects each visual step can see.
VISUAL_DEFECTS = ids({
    "Pericardium receiving inspection": ["TISSUE_TEAR", "CALCIFIC_SPOT", "FIBER_PARTICLE"],
    "Leaflet visual inspection": ["TISSUE_TEAR", "CALCIFIC_SPOT", "FIBER_PARTICLE"],
    "Suture line inspection": ["SUTURE_GAP", "FIBER_PARTICLE"],
    "Coaptation visual check": ["LEAFLET_MISALIGN", "SUTURE_GAP"],
    "Final visual inspection": ["TISSUE_TEAR", "FIBER_PARTICLE", "SUTURE_GAP", "LEAFLET_MISALIGN"],
})

# Transillumination scan: the vision system reports every inclusion it can see in the
# backlit leaflet. A scan is rejected on the count/size rule below, not on one defect.
SCAN_STEP = STEP_ID["Leaflet transillumination scan"]
SCAN_CLASSES = ["INCLUSION", "PARTICLE", "THIN_SPOT", "FIBER"]
SCAN_LIMITS = {"count": 18, "size_mm": 0.55}   # reject if either is exceeded

# Defects that cannot be reworked -> unit scrapped.
SCRAP_DEFECTS = {"TISSUE_TEAR", "CALCIFIC_SPOT"}

MODELS = ["HV-21", "HV-23", "HV-25", "HV-27", "HV-29"]

OPERATORS = [
    # id, name, shift, hire_date
    ("OP-01", "A. Rivera", "day", "2019-03-11"),
    ("OP-02", "B. Chen", "day", "2020-06-01"),
    ("OP-03", "C. Okafor", "day", "2018-01-15"),
    ("OP-04", "D. Novak", "day", "2021-09-20"),
    ("OP-05", "E. Haddad", "day", "2017-05-02"),
    ("OP-06", "F. Lindqvist", "day", "2022-02-14"),
    ("OP-07", "G. Patel", "swing", "2026-03-02"),   # new hire: suture learning curve
    ("OP-08", "H. Moreau", "swing", "2019-11-04"),
    ("OP-09", "I. Santos", "swing", "2020-08-17"),
    ("OP-10", "J. Kowalski", "swing", "2023-04-10"),
    ("OP-11", "K. Yamada", "swing", "2016-07-25"),
    ("OP-12", "L. Brennan", "swing", "2024-01-08"),
]


def equipment_for(step_id: int, step_type: str) -> list[tuple[str, str]]:
    """One or two stations per step (two where there's parallel capacity)."""
    code = {"process": "PR", "measurement": "MS", "visual": "VI", "gate": "GO", "scan": "TS"}[step_type]
    n = 2 if step_type != "process" or step_id in (23, 24, 26) else 1   # two stations where there is parallel capacity
    return [(f"{code}-{step_id:02d}-{k}", f"{code} station {step_id:02d}{'AB'[k - 1]}") for k in range(1, n + 1)]
