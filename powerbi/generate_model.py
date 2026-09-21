"""Generate the TMDL semantic model from one table spec.

Run after changing the exporter's columns:  python3 powerbi/generate_model.py
"""
from pathlib import Path

ROOT = Path(__file__).parent
SM = ROOT / "YieldAnalytics.SemanticModel"
DEF = SM / "definition"

S, I, D, DT, B = "string", "int64", "double", "dateTime", "boolean"
TABLES = {
    "dim_step": [("step_id", I), ("name", S), ("area", S), ("step_type", S), ("param_name", S), ("param_unit", S),
                 ("lsl", D), ("target", D), ("usl", D)],
    "dim_defect": [("defect_code", S), ("description", S), ("category", S)],
    "dim_operator": [("operator_id", S), ("name", S), ("shift", S), ("hire_date", DT)],
    "dim_equipment": [("equipment_id", S), ("step_id", I), ("name", S)],
    "dim_lot": [("lot_id", S), ("tissue_lot", S), ("frame_lot", S), ("released_at", DT)],
    "fact_unit": [("serial", S), ("lot_id", S), ("model", S), ("started_at", DT), ("completed_at", DT), ("status", S),
                  ("first_pass", B), ("start_date", DT), ("completion_date", DT), ("cycle_days", D), ("unit_url", S, "WebUrl")],
    "fact_step_event": [("event_id", I), ("serial", S), ("step_id", I), ("attempt", I), ("started_at", DT), ("ended_at", DT),
                        ("operator_id", S), ("equipment_id", S), ("result", S), ("defect_code", S), ("event_date", DT),
                        ("value", D), ("is_first_attempt", I), ("is_first_fail", I)],
    "fact_inspection": [("event_id", I), ("serial", S), ("step_id", I), ("attempt", I), ("ended_at", DT), ("event_date", DT),
                        ("operator_id", S), ("equipment_id", S), ("result", S), ("true_class", S), ("ai_class", S),
                        ("ai_confidence", D), ("ai_agrees", I), ("image_url", S, "ImageUrl"), ("unit_url", S, "WebUrl")],
}

MEASURES = {
    "fact_unit": [
        ("Units Completed", 'CALCULATE(COUNTROWS(fact_unit), fact_unit[status] <> "wip", USERELATIONSHIP(fact_unit[completion_date], \'Date\'[Date]))', "#,0"),
        ("Units Shipped", 'CALCULATE(COUNTROWS(fact_unit), fact_unit[status] = "shipped", USERELATIONSHIP(fact_unit[completion_date], \'Date\'[Date]))', "#,0"),
        ("Units Scrapped", 'CALCULATE(COUNTROWS(fact_unit), fact_unit[status] = "scrapped", USERELATIONSHIP(fact_unit[completion_date], \'Date\'[Date]))', "#,0"),
        ("First Pass Units", 'CALCULATE(COUNTROWS(fact_unit), fact_unit[status] <> "wip", fact_unit[first_pass] = TRUE(), USERELATIONSHIP(fact_unit[completion_date], \'Date\'[Date]))', "#,0"),
        ("WIP", 'CALCULATE(COUNTROWS(fact_unit), fact_unit[status] = "wip", REMOVEFILTERS(\'Date\'))', "#,0"),
        ("First Pass Yield", "DIVIDE([First Pass Units], [Units Completed])", "0.0%"),
        ("Final Yield", "DIVIDE([Units Shipped], [Units Completed])", "0.0%"),
        ("Avg Cycle Days", 'CALCULATE(AVERAGE(fact_unit[cycle_days]), fact_unit[status] <> "wip", USERELATIONSHIP(fact_unit[completion_date], \'Date\'[Date]))', "0.0"),
    ],
    "fact_step_event": [
        ("First Attempts", "SUM(fact_step_event[is_first_attempt])", "#,0"),
        ("First Attempt Fails", "SUM(fact_step_event[is_first_fail])", "#,0"),
        ("Step FPY", "IF([First Attempts] > 0, 1 - DIVIDE([First Attempt Fails], [First Attempts]))", "0.00%"),
        ("First Attempt Fail Rate", "DIVIDE([First Attempt Fails], [First Attempts])", "0.00%"),
        ("Rolled Throughput Yield", "PRODUCTX(FILTER(VALUES(dim_step[step_id]), [First Attempts] > 0), [Step FPY])", "0.0%"),
        ("Rework Events", 'CALCULATE(COUNTROWS(fact_step_event), fact_step_event[result] = "rework")', "#,0"),
        ("Scrap Events", 'CALCULATE(COUNTROWS(fact_step_event), fact_step_event[result] = "scrap")', "#,0"),
        ("Defect Events", "CALCULATE(COUNTROWS(fact_step_event), NOT ISBLANK(fact_step_event[defect_code]))", "#,0"),
        ("Measurement Mean", "CALCULATE(AVERAGE(fact_step_event[value]), fact_step_event[attempt] = 1)", "0.000"),
        ("Measurement StdDev", "CALCULATE(STDEV.S(fact_step_event[value]), fact_step_event[attempt] = 1)", "0.0000"),
        ("Cpk", """
				VAR mu = [Measurement Mean]
				VAR sd = [Measurement StdDev]
				VAR lsl = SELECTEDVALUE(dim_step[lsl])
				VAR usl = SELECTEDVALUE(dim_step[usl])
				RETURN IF(NOT ISBLANK(usl) && sd > 0, MIN(usl - mu, mu - lsl) / (3 * sd))""", "0.00"),
    ],
    "fact_inspection": [
        ("Images", "COUNTROWS(fact_inspection)", "#,0"),
        ("AI Agreement", "DIVIDE(SUM(fact_inspection[ai_agrees]), [Images])", "0.0%"),
        ("Defects Found by Inspector", 'CALCULATE([Images], fact_inspection[true_class] <> "ok")', "#,0"),
        ("Defects Missed by AI", 'CALCULATE([Images], fact_inspection[true_class] <> "ok", fact_inspection[ai_class] = "ok")', "#,0"),
        ("AI Recall", "1 - DIVIDE([Defects Missed by AI], [Defects Found by Inspector])", "0.0%"),
    ],
}

RELATIONSHIPS = [  # from (many) -> to (one), active
    ("fact_step_event", "step_id", "dim_step", "step_id", True),
    ("fact_step_event", "equipment_id", "dim_equipment", "equipment_id", True),
    ("fact_step_event", "operator_id", "dim_operator", "operator_id", True),
    ("fact_step_event", "defect_code", "dim_defect", "defect_code", True),
    ("fact_step_event", "serial", "fact_unit", "serial", True),
    ("fact_step_event", "event_date", "Date", "Date", True),
    ("fact_unit", "lot_id", "dim_lot", "lot_id", True),
    ("fact_unit", "completion_date", "Date", "Date", False),
    ("fact_inspection", "step_id", "dim_step", "step_id", True),
    ("fact_inspection", "serial", "fact_unit", "serial", True),
    ("fact_inspection", "event_date", "Date", "Date", False),
]


def q(name):  # TMDL object names with spaces need quotes
    return f"'{name}'" if not name.isidentifier() else name


def table_tmdl(name, cols):
    out = [f"table {name}", ""]
    for m_name, expr, fmt in MEASURES.get(name, []):
        expr = expr if expr.startswith("\n") else " " + expr
        out += [f"\tmeasure {q(m_name)} ={expr}", f"\t\tformatString: {fmt}", ""]
    for c in cols:
        col, typ = c[0], c[1]
        out += [f"\tcolumn {col}", f"\t\tdataType: {typ}", "\t\tsummarizeBy: none", f"\t\tsourceColumn: {col}"]
        if typ == DT:
            out.append("\t\tformatString: yyyy-mm-dd")
        if len(c) > 2:
            out.append(f"\t\tdataCategory: {c[2]}")
        out.append("")
    out += [f"\tpartition {name} = m", "\t\tmode: import", "\t\tsource =", "\t\t\t\tlet",
            f'\t\t\t\t    Source = #"Load Parquet"("{name}")', "\t\t\t\tin", "\t\t\t\t    Source", ""]
    return "\n".join(out)


DATE_TABLE = """table Date
	dataCategory: Time

	column Date
		dataType: dateTime
		isKey
		formatString: yyyy-mm-dd
		summarizeBy: none
		sourceColumn: [Date]

	column Month
		dataType: string
		summarizeBy: none
		sourceColumn: [Month]
		sortByColumn: MonthStart

	column MonthStart
		dataType: dateTime
		formatString: yyyy-mm-dd
		summarizeBy: none
		sourceColumn: [MonthStart]

	column Week
		dataType: dateTime
		formatString: yyyy-mm-dd
		summarizeBy: none
		sourceColumn: [Week]

	partition Date = calculated
		mode: import
		source =
				ADDCOLUMNS(
				    CALENDAR(DATE(2025, 9, 1), TODAY() + 31),
				    "Month", FORMAT([Date], "yyyy-mm"),
				    "MonthStart", DATE(YEAR([Date]), MONTH([Date]), 1),
				    "Week", [Date] - WEEKDAY([Date], 3)
				)
"""

EXPRESSIONS = """expression BaseUrl = "https://yield.frontanalytics.com/exports" meta [IsParameterQuery=true, Type="Text", IsParameterQueryRequired=true]

expression AccessKey = "set-me" meta [IsParameterQuery=true, Type="Text", IsParameterQueryRequired=true]

/// Loads one exporter table. Web.Contents with a fixed base URL + RelativePath keeps the
/// data source static, so Power BI Service can refresh it without a gateway.
expression 'Load Parquet' =
		(name as text) as table =>
		let
		    Bin = Web.Contents(BaseUrl, [RelativePath = name & ".parquet", Query = [key = AccessKey]]),
		    Tbl = Parquet.Document(Bin)
		in
		    Tbl
"""


def main():
    (DEF / "tables").mkdir(parents=True, exist_ok=True)
    (SM / "definition.pbism").write_text('{\n  "version": "4.0",\n  "settings": {}\n}\n')
    (DEF / "database.tmdl").write_text("database\n\tcompatibilityLevel: 1600\n")
    refs = "".join(f"ref table {q(t)}\n" for t in [*TABLES, "Date"])
    (DEF / "model.tmdl").write_text(f"model Model\n\tculture: en-US\n\tdefaultPowerBIDataSourceVersion: powerBI_V3\n"
                                    f"\tdiscourageImplicitMeasures\n\n{refs}")
    (DEF / "expressions.tmdl").write_text(EXPRESSIONS)
    for name, cols in TABLES.items():
        (DEF / "tables" / f"{name}.tmdl").write_text(table_tmdl(name, cols))
    (DEF / "tables" / "Date.tmdl").write_text(DATE_TABLE)
    rel = []
    for i, (ft, fc, tt, tc, active) in enumerate(RELATIONSHIPS):
        rel += [f"relationship r{i:02d}_{ft}_{fc}", f"\tfromColumn: {q(ft)}.{fc}", f"\ttoColumn: {q(tt)}.{tc}"]
        if not active:
            rel.append("\tisActive: false")
        rel.append("")
    (DEF / "relationships.tmdl").write_text("\n".join(rel))
    print("wrote", DEF)


if __name__ == "__main__":
    main()
