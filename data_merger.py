"""
data_merger.py
──────────────
Module for merging two or more cleaned DataFrames.
Supports column mapping (rename before merge), join type selection,
and returns the merged DataFrame + a log of actions.
"""

import pandas as pd
from typing import Any


VALID_JOIN_TYPES = {"inner", "left", "right", "outer"}


def apply_column_mapping(df: pd.DataFrame, mapping: dict[str, str]) -> pd.DataFrame:
    """
    Rename columns according to *mapping* (old_name → new_name).
    Returns a copy with renamed columns.
    """
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

    # Validate merge keys exist
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
        "left_unmatched": len(left) - len(left.merge(right[on].drop_duplicates(), on=on, how="inner")) if how != "inner" else 0,
    }


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

    # Final summary
    total_cols = len(result.columns)
    log.append({
        "action": "summary",
        "detail": f"Final merged dataset: {len(result)} rows × {total_cols} columns"
    })

    result.reset_index(drop=True, inplace=True)
    return result, log
