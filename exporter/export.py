"""Snapshot the yield database to Parquet for Power BI.

Writes one file per table under EXPORT_DIR and, when AZURE_STORAGE_CONNECTION_STRING
is set, uploads them to the blob container AZURE_STORAGE_CONTAINER (default 'yield').
Power BI Service refreshes from that container with no gateway. Full snapshots are
fine at this scale (~5k events/month); see docs/architecture.md for the
incremental design used at production volume.
"""

import logging
import os
import time
from pathlib import Path

import pyarrow as pa
import pyarrow.parquet as pq
import pymssql

log = logging.getLogger("exporter")
EXPORT_DIR = Path(os.environ.get("EXPORT_DIR", "/data/exports"))
PUBLIC_URL = os.environ.get("PUBLIC_URL", "http://localhost:8000").rstrip("/")

# Power BI-friendly shapes: a star schema with one wide fact per grain.
QUERIES = {
    "dim_step": "SELECT * FROM mfg.step",
    "dim_defect": "SELECT * FROM mfg.defect",
    "dim_operator": "SELECT * FROM mfg.operator",
    "dim_equipment": "SELECT * FROM mfg.equipment",
    "dim_lot": "SELECT * FROM mfg.lot",
    "fact_unit": """
        SELECT u.*, CAST(u.started_at AS DATE) start_date, CAST(u.completed_at AS DATE) completion_date,
               DATEDIFF(hour, u.started_at, u.completed_at) / 24.0 cycle_days,
               %(url)s + '/units/' + u.serial AS unit_url
        FROM mfg.unit u""",
    "fact_step_event": """
        SELECT ev.*, CAST(ev.ended_at AS DATE) event_date, m.value,
               CASE WHEN ev.attempt = 1 THEN 1 ELSE 0 END is_first_attempt,
               CASE WHEN ev.attempt = 1 AND ev.result <> 'pass' THEN 1 ELSE 0 END is_first_fail
        FROM mfg.step_event ev LEFT JOIN mfg.measurement m ON m.event_id = ev.event_id""",
    "fact_inspection": """
        SELECT i.event_id, ev.serial, ev.step_id, ev.attempt, ev.ended_at, CAST(ev.ended_at AS DATE) event_date,
               ev.operator_id, ev.equipment_id, ev.result, i.true_class, i.ai_class, i.ai_confidence,
               CASE WHEN i.true_class = i.ai_class THEN 1 ELSE 0 END ai_agrees,
               %(url)s + '/api/images/' + CAST(i.event_id AS VARCHAR(20)) + '.png' AS image_url,
               %(url)s + '/units/' + ev.serial AS unit_url
        FROM mfg.inspection_image i JOIN mfg.step_event ev ON ev.event_id = i.event_id""",
}


def export_once():
    conn = pymssql.connect(server=os.environ.get("DB_HOST", "db"), user=os.environ.get("DB_USER", "sa"),
                           password=os.environ["DB_PASSWORD"], database="yield", as_dict=True)
    EXPORT_DIR.mkdir(parents=True, exist_ok=True)
    written = []
    for name, sql in QUERIES.items():
        cur = conn.cursor()
        cur.execute(sql, {"url": PUBLIC_URL}) if "%(url)s" in sql else cur.execute(sql)
        rows = cur.fetchall()
        table = pa.Table.from_pylist(rows) if rows else pa.table({})
        tmp = EXPORT_DIR / f".{name}.parquet"
        pq.write_table(table, tmp, compression="zstd")
        tmp.replace(EXPORT_DIR / f"{name}.parquet")
        written.append((name, len(rows)))
    conn.close()
    log.info("exported %s", ", ".join(f"{n}={c}" for n, c in written))
    upload([EXPORT_DIR / f"{n}.parquet" for n, _ in written])


def upload(files):
    cs = os.environ.get("AZURE_STORAGE_CONNECTION_STRING")
    if not cs:
        log.info("AZURE_STORAGE_CONNECTION_STRING not set; skipping upload")
        return
    from azure.storage.blob import BlobServiceClient

    container = BlobServiceClient.from_connection_string(cs).get_container_client(
        os.environ.get("AZURE_STORAGE_CONTAINER", "yield"))
    if not container.exists():
        container.create_container()
    for f in files:
        with open(f, "rb") as fh:
            container.upload_blob(f"parquet/{f.name}", fh, overwrite=True)
    log.info("uploaded %d files to %s", len(files), container.container_name)


def main():
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(message)s")
    interval = int(os.environ.get("EXPORT_INTERVAL_SECONDS", "3600"))
    while True:
        try:
            export_once()
            wait = interval
        except Exception as e:  # e.g. simulator still backfilling on first start
            log.warning("export failed (%s); retrying in 60s", str(e)[:120])
            wait = 60
        if interval <= 0:
            return
        time.sleep(wait)


if __name__ == "__main__":
    main()
