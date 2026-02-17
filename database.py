import sqlite3
import json
import uuid
from datetime import datetime
from pathlib import Path

DB_PATH = Path(__file__).parent / "dashboards.db"


def get_db():
    conn = sqlite3.connect(str(DB_PATH))
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=ON")
    return conn


def init_db():
    conn = get_db()
    conn.executescript("""
        CREATE TABLE IF NOT EXISTS sessions (
            session_id TEXT PRIMARY KEY,
            created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS dashboards (
            id TEXT PRIMARY KEY,
            session_id TEXT NOT NULL,
            name TEXT NOT NULL,
            created_at TEXT NOT NULL DEFAULT (datetime('now')),
            FOREIGN KEY (session_id) REFERENCES sessions(session_id)
        );

        CREATE TABLE IF NOT EXISTS csv_files (
            id TEXT PRIMARY KEY,
            dashboard_id TEXT NOT NULL,
            original_filename TEXT NOT NULL,
            stored_filename TEXT NOT NULL,
            file_path TEXT NOT NULL,
            row_count INTEGER,
            col_count INTEGER,
            columns_meta TEXT,  -- JSON: column names, types, stats
            uploaded_at TEXT NOT NULL DEFAULT (datetime('now')),
            FOREIGN KEY (dashboard_id) REFERENCES dashboards(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS charts (
            id TEXT PRIMARY KEY,
            dashboard_id TEXT NOT NULL,
            csv_file_id TEXT NOT NULL,
            chart_type TEXT NOT NULL,
            title TEXT NOT NULL,
            config TEXT NOT NULL,  -- JSON: full chart config for frontend
            sort_order INTEGER DEFAULT 0,
            created_at TEXT NOT NULL DEFAULT (datetime('now')),
            FOREIGN KEY (dashboard_id) REFERENCES dashboards(id) ON DELETE CASCADE,
            FOREIGN KEY (csv_file_id) REFERENCES csv_files(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS merge_sessions (
            id TEXT PRIMARY KEY,
            dashboard_id TEXT NOT NULL,
            merge_keys TEXT NOT NULL,      -- JSON array of key column names
            join_type TEXT NOT NULL DEFAULT 'inner',
            column_mappings TEXT,           -- JSON: per-csv column mappings
            cleaning_log TEXT,             -- JSON: cleaning actions
            merge_log TEXT,                -- JSON: merge actions
            merged_file_path TEXT,         -- path to saved merged CSV
            row_count INTEGER,
            col_count INTEGER,
            columns_info TEXT,             -- JSON: column metadata of merged result
            created_at TEXT NOT NULL DEFAULT (datetime('now')),
            FOREIGN KEY (dashboard_id) REFERENCES dashboards(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS csv_roles (
            id TEXT PRIMARY KEY,
            csv_file_id TEXT NOT NULL,
            role TEXT NOT NULL DEFAULT 'primary',
            sort_order INTEGER DEFAULT 0,
            FOREIGN KEY (csv_file_id) REFERENCES csv_files(id) ON DELETE CASCADE
        );
    """)
    conn.commit()
    conn.close()


def get_or_create_session(session_id: str | None) -> str:
    conn = get_db()
    if session_id:
        row = conn.execute("SELECT session_id FROM sessions WHERE session_id = ?", (session_id,)).fetchone()
        if row:
            conn.close()
            return session_id
    new_id = str(uuid.uuid4())
    conn.execute("INSERT INTO sessions (session_id) VALUES (?)", (new_id,))
    conn.commit()
    conn.close()
    return new_id


def create_dashboard(session_id: str, name: str) -> str:
    dashboard_id = str(uuid.uuid4())
    conn = get_db()
    conn.execute(
        "INSERT INTO dashboards (id, session_id, name) VALUES (?, ?, ?)",
        (dashboard_id, session_id, name),
    )
    conn.commit()
    conn.close()
    return dashboard_id


def save_csv_metadata(dashboard_id: str, original_filename: str, stored_filename: str,
                      file_path: str, row_count: int, col_count: int, columns_meta: dict) -> str:
    csv_id = str(uuid.uuid4())
    conn = get_db()
    conn.execute(
        """INSERT INTO csv_files (id, dashboard_id, original_filename, stored_filename,
           file_path, row_count, col_count, columns_meta)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
        (csv_id, dashboard_id, original_filename, stored_filename,
         file_path, row_count, col_count, json.dumps(columns_meta)),
    )
    conn.commit()
    conn.close()
    return csv_id


def save_charts(dashboard_id: str, csv_file_id: str, charts: list[dict]) -> list[dict]:
    """Save charts and return them with their assigned IDs."""
    conn = get_db()
    saved = []
    for i, chart in enumerate(charts):
        chart_id = str(uuid.uuid4())
        conn.execute(
            """INSERT INTO charts (id, dashboard_id, csv_file_id, chart_type, title, config, sort_order)
               VALUES (?, ?, ?, ?, ?, ?, ?)""",
            (chart_id, dashboard_id, csv_file_id,
             chart["chart_type"], chart["title"], json.dumps(chart["config"]), i),
        )
        saved.append({
            "id": chart_id,
            "csv_file_id": csv_file_id,
            "chart_type": chart["chart_type"],
            "title": chart["title"],
            "config": chart["config"],
        })
    conn.commit()
    conn.close()
    return saved


def get_dashboards(session_id: str) -> list[dict]:
    conn = get_db()
    rows = conn.execute(
        """SELECT d.id, d.name, d.created_at,
                  COUNT(c.id) as chart_count,
                  GROUP_CONCAT(DISTINCT cf.original_filename) as csv_files
           FROM dashboards d
           LEFT JOIN charts c ON c.dashboard_id = d.id
           LEFT JOIN csv_files cf ON cf.dashboard_id = d.id
           WHERE d.session_id = ?
           GROUP BY d.id
           ORDER BY d.created_at DESC""",
        (session_id,),
    ).fetchall()
    conn.close()
    return [dict(r) for r in rows]


def get_dashboard(dashboard_id: str, session_id: str) -> dict | None:
    conn = get_db()
    dash = conn.execute(
        "SELECT * FROM dashboards WHERE id = ? AND session_id = ?",
        (dashboard_id, session_id),
    ).fetchone()
    if not dash:
        conn.close()
        return None

    csv_files = conn.execute(
        "SELECT * FROM csv_files WHERE dashboard_id = ? ORDER BY rowid",
        (dashboard_id,),
    ).fetchall()

    # Order charts grouped by csv_file insertion order (rowid), then by sort_order
    charts = conn.execute(
        """SELECT ch.* FROM charts ch
           LEFT JOIN csv_files cf ON cf.id = ch.csv_file_id AND cf.dashboard_id = ch.dashboard_id
           WHERE ch.dashboard_id = ?
           ORDER BY cf.rowid, ch.sort_order""",
        (dashboard_id,),
    ).fetchall()

    conn.close()
    result = dict(dash)
    result["csv_files"] = [dict(f) for f in csv_files]
    result["charts"] = [{**dict(c), "config": json.loads(c["config"])} for c in charts]
    return result


def delete_dashboard(dashboard_id: str, session_id: str) -> bool:
    conn = get_db()
    cursor = conn.execute(
        "DELETE FROM dashboards WHERE id = ? AND session_id = ?",
        (dashboard_id, session_id),
    )
    conn.commit()
    deleted = cursor.rowcount > 0
    conn.close()
    return deleted


def rename_dashboard(dashboard_id: str, session_id: str, new_name: str) -> bool:
    conn = get_db()
    cursor = conn.execute(
        "UPDATE dashboards SET name = ? WHERE id = ? AND session_id = ?",
        (new_name, dashboard_id, session_id),
    )
    conn.commit()
    updated = cursor.rowcount > 0
    conn.close()
    return updated


def delete_chart(chart_id: str, dashboard_id: str) -> bool:
    conn = get_db()
    cursor = conn.execute(
        "DELETE FROM charts WHERE id = ? AND dashboard_id = ?",
        (chart_id, dashboard_id),
    )
    conn.commit()
    deleted = cursor.rowcount > 0
    conn.close()
    return deleted


def rename_chart(chart_id: str, dashboard_id: str, new_title: str) -> bool:
    conn = get_db()
    # Update both the title column and the title inside the config JSON
    row = conn.execute("SELECT config FROM charts WHERE id = ? AND dashboard_id = ?",
                        (chart_id, dashboard_id)).fetchone()
    if not row:
        conn.close()
        return False
    cfg = json.loads(row["config"])
    if cfg.get("options", {}).get("plugins", {}).get("title"):
        cfg["options"]["plugins"]["title"]["text"] = new_title
    cursor = conn.execute(
        "UPDATE charts SET title = ?, config = ? WHERE id = ? AND dashboard_id = ?",
        (new_title, json.dumps(cfg), chart_id, dashboard_id),
    )
    conn.commit()
    updated = cursor.rowcount > 0
    conn.close()
    return updated


# ── CSV Roles ─────────────────────────────────────────────────────
def save_csv_role(csv_file_id: str, role: str, sort_order: int = 0) -> str:
    role_id = str(uuid.uuid4())
    conn = get_db()
    conn.execute(
        "INSERT OR REPLACE INTO csv_roles (id, csv_file_id, role, sort_order) VALUES (?, ?, ?, ?)",
        (role_id, csv_file_id, role, sort_order),
    )
    conn.commit()
    conn.close()
    return role_id


def get_csv_roles(dashboard_id: str) -> list[dict]:
    conn = get_db()
    rows = conn.execute(
        """SELECT r.id, r.csv_file_id, r.role, r.sort_order, cf.original_filename
           FROM csv_roles r
           JOIN csv_files cf ON cf.id = r.csv_file_id
           WHERE cf.dashboard_id = ?
           ORDER BY r.sort_order""",
        (dashboard_id,),
    ).fetchall()
    conn.close()
    return [dict(r) for r in rows]


# ── Merge Sessions ────────────────────────────────────────────────
def save_merge_session(
    dashboard_id: str,
    merge_keys: list,
    join_type: str,
    column_mappings: dict | None,
    cleaning_log: list,
    merge_log: list,
    merged_file_path: str,
    row_count: int,
    col_count: int,
    columns_info: list,
) -> str:
    merge_id = str(uuid.uuid4())
    conn = get_db()
    conn.execute(
        """INSERT INTO merge_sessions
           (id, dashboard_id, merge_keys, join_type, column_mappings,
            cleaning_log, merge_log, merged_file_path, row_count, col_count, columns_info)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
        (merge_id, dashboard_id,
         json.dumps(merge_keys), join_type,
         json.dumps(column_mappings) if column_mappings else None,
         json.dumps(cleaning_log), json.dumps(merge_log),
         merged_file_path, row_count, col_count, json.dumps(columns_info)),
    )
    conn.commit()
    conn.close()
    return merge_id


def get_merge_sessions(dashboard_id: str) -> list[dict]:
    conn = get_db()
    rows = conn.execute(
        "SELECT * FROM merge_sessions WHERE dashboard_id = ? ORDER BY created_at DESC",
        (dashboard_id,),
    ).fetchall()
    conn.close()
    result = []
    for r in rows:
        d = dict(r)
        for key in ("merge_keys", "column_mappings", "cleaning_log", "merge_log", "columns_info"):
            if d.get(key) and isinstance(d[key], str):
                d[key] = json.loads(d[key])
        result.append(d)
    return result


def get_merge_session(merge_id: str) -> dict | None:
    conn = get_db()
    row = conn.execute("SELECT * FROM merge_sessions WHERE id = ?", (merge_id,)).fetchone()
    conn.close()
    if not row:
        return None
    d = dict(row)
    for key in ("merge_keys", "column_mappings", "cleaning_log", "merge_log", "columns_info"):
        if d.get(key) and isinstance(d[key], str):
            d[key] = json.loads(d[key])
    return d
