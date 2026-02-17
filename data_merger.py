"""
data_merger.py
──────────────
Module for merging two or more cleaned DataFrames.
Supports:
  - column mapping (rename before merge)
  - common-key merging (legacy)
  - relationship-based merging (PK/FK pairwise joins)
  - auto-detection of candidate key columns
"""

import pandas as pd
from typing import Any


VALID_JOIN_TYPES = {"inner", "left", "right", "outer"}


# ── Helpers ──────────────────────────────────────────────────────

def apply_column_mapping(df: pd.DataFrame, mapping: dict[str, str]) -> pd.DataFrame:
    """Rename columns according to *mapping* (old_name → new_name)."""
    if not mapping:
        return df
    return df.rename(columns=mapping)


def find_common_columns(dfs: list[pd.DataFrame]) -> list[str]:
    """Return column names common to ALL DataFrames."""
    if not dfs:
        return []
    common = set(dfs[0].columns)
    for df in dfs[1:]:
        common &= set(df.columns)
    return sorted(common)


# ── Auto-detect candidate key columns ───────────────────────────

def detect_candidate_keys(df: pd.DataFrame, filename: str = "") -> list[dict]:
    """
    Heuristically identify columns that look like primary keys or
    foreign keys (IDs, dates, high-uniqueness columns).

    Returns a list of dicts:
        { "column": str, "key_type": "primary"|"candidate",
          "reason": str, "uniqueness": float }
    """
    candidates: list[dict] = []
    n = len(df)
    if n == 0:
        return candidates

    for col in df.columns:
        s = df[col].dropna()
        if s.empty:
            continue

        nunique = s.nunique()
        ratio = nunique / n if n else 0
        col_lower = col.lower().strip()

        # --- Primary key: unique numeric column ending with _id / id ---
        is_id_col = (
            col_lower.endswith("_id")
            or col_lower == "id"
            or col_lower.endswith("id")
            or col_lower.endswith("_key")
        )

        if is_id_col and pd.api.types.is_numeric_dtype(s):
            if ratio > 0.95:
                candidates.append({
                    "column": col,
                    "key_type": "primary",
                    "reason": f"Numeric ID column, {ratio:.0%} unique",
                    "uniqueness": round(ratio, 4),
                })
            else:
                candidates.append({
                    "column": col,
                    "key_type": "candidate",
                    "reason": f"Numeric ID column (FK?), {ratio:.0%} unique",
                    "uniqueness": round(ratio, 4),
                })
            continue

        # --- High-uniqueness column (potential natural key) ---
        if ratio > 0.9 and pd.api.types.is_numeric_dtype(s):
            candidates.append({
                "column": col,
                "key_type": "candidate",
                "reason": f"High-uniqueness numeric, {ratio:.0%} unique",
                "uniqueness": round(ratio, 4),
            })

    return candidates


def auto_detect_relationships(
    files_info: list[dict],
) -> list[dict]:
    """
    Given a list of {csv_file_id, filename, columns: [{name, dtype, nunique, ...}], candidate_keys: [...]},
    auto-detect likely FK→PK relationships across CSVs by matching column names
    that look like keys.

    Returns list of suggested relationships:
        { "from_csv": str, "from_column": str,
          "to_csv": str, "to_column": str,
          "confidence": float, "reason": str }
    """
    relationships: list[dict] = []
    seen = set()  # avoid duplicates

    for i, f1 in enumerate(files_info):
        for j, f2 in enumerate(files_info):
            if i >= j:
                continue
            f1_cols = {c["name"]: c for c in f1["columns"]}
            f2_cols = {c["name"]: c for c in f2["columns"]}

            # Find columns with matching names in both CSVs
            common = set(f1_cols.keys()) & set(f2_cols.keys())
            for col_name in common:
                c1 = f1_cols[col_name]
                c2 = f2_cols[col_name]
                col_lower = col_name.lower()

                # Only suggest if both are numeric or both are categorical
                if c1["dtype"] != c2["dtype"]:
                    continue

                is_key_like = (
                    col_lower.endswith("_id")
                    or col_lower == "id"
                    or col_lower.endswith("id")
                    or col_lower.endswith("_key")
                    or col_lower.endswith("_code")
                )

                if not is_key_like:
                    continue

                # Determine direction: PK is in the file with higher uniqueness
                u1 = c1.get("nunique", 0)
                u2 = c2.get("nunique", 0)
                n1 = len([x for x in f1["columns"]])  # proxy
                n2 = len([x for x in f2["columns"]])

                pair_key = tuple(sorted([
                    (f1["csv_file_id"], col_name),
                    (f2["csv_file_id"], col_name),
                ]))
                if pair_key in seen:
                    continue
                seen.add(pair_key)

                # Higher ratio → more likely PK
                if u1 >= u2:
                    pk_file, fk_file = f1, f2
                else:
                    pk_file, fk_file = f2, f1

                confidence = 0.9 if is_key_like else 0.5
                relationships.append({
                    "from_csv": fk_file["csv_file_id"],
                    "from_column": col_name,
                    "to_csv": pk_file["csv_file_id"],
                    "to_column": col_name,
                    "confidence": confidence,
                    "reason": f"Matching key column '{col_name}' across {fk_file['filename']} → {pk_file['filename']}",
                })

    # Sort by confidence descending
    relationships.sort(key=lambda r: -r["confidence"])
    return relationships


# ── Preview merge (legacy pairwise) ─────────────────────────────

def preview_merge(
    left: pd.DataFrame,
    right: pd.DataFrame,
    on: list[str],
    how: str = "inner",
    left_mapping: dict[str, str] | None = None,
    right_mapping: dict[str, str] | None = None,
    preview_rows: int = 10,
) -> dict[str, Any]:
    """
    Perform a trial merge and return a preview (first N rows) + stats.
    Does NOT modify the originals.
    """
    l = apply_column_mapping(left.copy(), left_mapping or {})
    r = apply_column_mapping(right.copy(), right_mapping or {})

    missing_left = [c for c in on if c not in l.columns]
    missing_right = [c for c in on if c not in r.columns]
    if missing_left:
        return {"ok": False, "error": f"Columns not in left CSV: {missing_left}"}
    if missing_right:
        return {"ok": False, "error": f"Columns not in right CSV: {missing_right}"}

    merged = l.merge(r, on=on, how=how, suffixes=("", "_right"))

    return {
        "ok": True,
        "rows": len(merged),
        "cols": len(merged.columns),
        "columns": merged.columns.tolist(),
        "preview": merged.head(preview_rows).fillna("").to_dict(orient="records"),
        "left_rows": len(left),
        "right_rows": len(right),
        "left_unmatched": len(left) - len(
            left.merge(right[on].drop_duplicates(), on=on, how="inner")
        ) if how != "inner" else 0,
    }


# ── Merge: legacy common-key approach ───────────────────────────

def merge_dataframes(
    dfs: list[pd.DataFrame],
    merge_keys: list[str],
    how: str = "inner",
    column_mappings: list[dict[str, str]] | None = None,
) -> tuple[pd.DataFrame, list[dict[str, Any]]]:
    """
    Sequentially merge a list of DataFrames on *merge_keys*.
    *column_mappings* is a list of dicts (one per df) mapping old→new col names.
    Returns (merged_df, log).
    """
    log: list[dict[str, Any]] = []

    if how not in VALID_JOIN_TYPES:
        raise ValueError(f"Invalid join type '{how}'. Must be one of {VALID_JOIN_TYPES}")

    if not dfs:
        raise ValueError("No DataFrames to merge")

    if len(dfs) == 1:
        log.append({"action": "skip", "detail": "Only one DataFrame — no merge needed"})
        return dfs[0].copy(), log

    # Apply column mappings
    mapped_dfs = []
    for i, df in enumerate(dfs):
        mapping = (column_mappings[i] if column_mappings and i < len(column_mappings) else {})
        mapped = apply_column_mapping(df.copy(), mapping)
        if mapping:
            log.append({"action": "column_mapping", "detail":
                        f"CSV #{i+1}: renamed {mapping}"})
        mapped_dfs.append(mapped)

    # Validate merge keys exist in all dfs
    for i, df in enumerate(mapped_dfs):
        missing = [k for k in merge_keys if k not in df.columns]
        if missing:
            raise ValueError(f"Merge key(s) {missing} not found in CSV #{i+1}. "
                             f"Available columns: {df.columns.tolist()}")

    # Sequential merge
    result = mapped_dfs[0]
    for i in range(1, len(mapped_dfs)):
        left_rows = len(result)
        right_rows = len(mapped_dfs[i])
        result = result.merge(mapped_dfs[i], on=merge_keys, how=how, suffixes=("", f"_{i+1}"))
        log.append({
            "action": "merge",
            "detail": f"Merged CSV #{i+1} ({right_rows} rows) into result ({left_rows} rows) "
                      f"on {merge_keys} ({how} join) → {len(result)} rows"
        })

    total_cols = len(result.columns)
    log.append({
        "action": "summary",
        "detail": f"Final merged dataset: {len(result)} rows × {total_cols} columns"
    })

    result.reset_index(drop=True, inplace=True)
    return result, log


# ── Merge: relationship-based (PK/FK pairwise joins) ────────────

def merge_by_relationships(
    dfs_map: dict[str, pd.DataFrame],
    relationships: list[dict],
    how: str = "inner",
    column_mappings: dict[str, dict[str, str]] | None = None,
) -> tuple[pd.DataFrame, list[dict[str, Any]]]:
    """
    Merge DataFrames using explicit pairwise relationships.

    Parameters
    ----------
    dfs_map : dict
        csv_file_id → DataFrame
    relationships : list[dict]
        Each dict: { "from_csv": id, "from_column": str,
                     "to_csv": id, "to_column": str }
    how : str
        Join type (inner, left, right, outer).
    column_mappings : dict | None
        csv_file_id → {old_col: new_col} rename mapping.

    Returns (merged_df, log)
    """
    log: list[dict[str, Any]] = []

    if not relationships:
        raise ValueError("No relationships defined")

    if how not in VALID_JOIN_TYPES:
        raise ValueError(f"Invalid join type '{how}'")

    # Apply column mappings
    mapped: dict[str, pd.DataFrame] = {}
    for cid, df in dfs_map.items():
        cm = (column_mappings or {}).get(cid, {})
        m = apply_column_mapping(df.copy(), cm)
        if cm:
            log.append({"action": "column_mapping",
                        "detail": f"{cid}: renamed {cm}"})
        mapped[cid] = m

    # Build a join order using BFS from the first relationship
    merged_ids = set()
    result = None

    # Collect all unique CSV IDs from relationships
    rel_csv_ids = set()
    for r in relationships:
        rel_csv_ids.add(r["from_csv"])
        rel_csv_ids.add(r["to_csv"])

    # Start with the first CSV mentioned
    start_id = relationships[0]["from_csv"]
    result = mapped[start_id]
    merged_ids.add(start_id)

    log.append({
        "action": "start",
        "detail": f"Starting with {start_id} ({len(result)} rows)"
    })

    # Process relationships iteratively until all connected CSVs are merged
    remaining = list(relationships)
    max_iter = len(remaining) * 2 + 5  # safety
    iteration = 0

    while remaining and iteration < max_iter:
        iteration += 1
        merged_any = False

        for rel in list(remaining):
            from_csv = rel["from_csv"]
            to_csv = rel["to_csv"]
            from_col = rel["from_column"]
            to_col = rel["to_column"]

            # Determine which side is already in merged result
            if from_csv in merged_ids and to_csv not in merged_ids:
                # Merge to_csv into result
                right_df = mapped[to_csv]
                left_col = from_col
                right_col = to_col
                joining_id = to_csv
            elif to_csv in merged_ids and from_csv not in merged_ids:
                # Merge from_csv into result
                right_df = mapped[from_csv]
                left_col = to_col
                right_col = from_col
                joining_id = from_csv
            elif from_csv in merged_ids and to_csv in merged_ids:
                # Both already merged, skip
                remaining.remove(rel)
                continue
            else:
                # Neither side merged yet, skip for now
                continue

            # Validate columns exist
            if left_col not in result.columns:
                raise ValueError(
                    f"Column '{left_col}' not found in merged result. "
                    f"Available: {result.columns.tolist()}"
                )
            if right_col not in right_df.columns:
                raise ValueError(
                    f"Column '{right_col}' not found in {joining_id}. "
                    f"Available: {right_df.columns.tolist()}"
                )

            left_rows = len(result)
            right_rows = len(right_df)

            # Merge
            if left_col == right_col:
                result = result.merge(
                    right_df, on=left_col, how=how,
                    suffixes=("", f"_{joining_id[:8]}")
                )
            else:
                result = result.merge(
                    right_df,
                    left_on=left_col, right_on=right_col,
                    how=how,
                    suffixes=("", f"_{joining_id[:8]}")
                )

            merged_ids.add(joining_id)
            remaining.remove(rel)
            merged_any = True

            log.append({
                "action": "merge",
                "detail": (
                    f"Joined {joining_id} ({right_rows} rows) "
                    f"on {left_col}↔{right_col} ({how}) "
                    f"→ {len(result)} rows"
                )
            })
            break  # restart loop to re-check remaining

        if not merged_any and remaining:
            # Try to start a new chain with an unmerged CSV
            for rel in remaining:
                for cid in [rel["from_csv"], rel["to_csv"]]:
                    if cid not in merged_ids and cid in mapped:
                        # Cross-join warning: merge with no key
                        result = result.merge(
                            mapped[cid], how="cross"
                        ) if hasattr(pd.DataFrame, 'merge') else pd.merge(
                            result, mapped[cid], how="cross"
                        )
                        merged_ids.add(cid)
                        log.append({
                            "action": "warning",
                            "detail": f"No direct relationship path to {cid}, added via cross join"
                        })
                        break
                break

    log.append({
        "action": "summary",
        "detail": f"Final merged dataset: {len(result)} rows × {len(result.columns)} columns"
    })

    result.reset_index(drop=True, inplace=True)
    return result, log
