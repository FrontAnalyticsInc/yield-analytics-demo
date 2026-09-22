"""Database helpers shared by the API modules."""

import os

import pymssql


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


def execute(statements: list[tuple[str, tuple]]):
    """Run several statements in one transaction."""
    conn = connect()
    try:
        cur = conn.cursor()
        for sql, params in statements:
            cur.execute(sql, params)
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()
