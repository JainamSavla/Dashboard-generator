"""
data_cleaner.py
───────────────
Module for cleaning and preprocessing individual DataFrames.
Actions: missing-value handling, duplicate removal, date standardisation,
categorical fill, numeric normalisation/outlier capping.
Returns a cleaned DataFrame **and** a human-readable log of every action taken.
"""

import pandas as pd
import numpy as np
from typing import Any


# ── Configuration defaults ───────────────────────────────────────
NUMERIC_IMPUTE_STRATEGY = "median"        # "mean" | "median" | "drop"
CATEGORICAL_FILL = "Unknown"
DUPLICATE_SUBSET = None                   # None = full-row; set list of cols for key-based
OUTLIER_METHOD = "iqr"                    # "iqr" | "zscore" | None
IQR_FACTOR = 1.5
ZSCORE_THRESHOLD = 3.0
NORMALIZE_METHOD = None                  # "minmax" | "zscore" | None  (off by default)


def clean_dataframe(
    df: pd.DataFrame,
    *,
    numeric_strategy: str = NUMERIC_IMPUTE_STRATEGY,
    categorical_fill: str = CATEGORICAL_FILL,
    dedup_subset: list[str] | None = DUPLICATE_SUBSET,
    outlier_method: str | None = OUTLIER_METHOD,
    normalize: str | None = NORMALIZE_METHOD,
    date_format: str | None = None,       # e.g. "%Y-%m-%d"
) -> tuple[pd.DataFrame, list[dict[str, Any]]]:
    """
    Clean *df* in-place and return (cleaned_df, log).
    Each entry in *log* is {"action": str, "column": str|None, "detail": str}.
    """
    log: list[dict[str, Any]] = []
    df = df.copy()
    original_rows = len(df)
    original_cols = len(df.columns)

    # 0 ── strip whitespace from column names ──────────────────────
    df.columns = df.columns.str.strip()

    # 1 ── classify columns ────────────────────────────────────────
    numeric_cols = df.select_dtypes(include="number").columns.tolist()
    cat_cols = []
    date_cols = []

    for col in df.columns:
        if col in numeric_cols:
            continue
        s = df[col].dropna()
        if s.empty:
            cat_cols.append(col)
            continue
        # try datetime
        if s.dtype == "object" or s.dtype.name in ("str", "string"):
            try:
                parsed = pd.to_datetime(s, format="mixed", dayfirst=False)
                if parsed.notna().sum() > len(s) * 0.6:
                    df[col] = pd.to_datetime(df[col], format="mixed", errors="coerce")
                    date_cols.append(col)
                    log.append({"action": "parse_date", "column": col,
                                "detail": f"Parsed as datetime ({parsed.notna().sum()}/{len(s)} valid)"})
                    continue
            except (ValueError, TypeError):
                pass
        cat_cols.append(col)

    # 2 ── handle missing values ───────────────────────────────────
    for col in numeric_cols:
        n_missing = int(df[col].isna().sum())
        if n_missing == 0:
            continue
        if numeric_strategy == "mean":
            fill_val = float(df[col].mean())
            df[col].fillna(fill_val, inplace=True)
            log.append({"action": "impute_mean", "column": col,
                         "detail": f"Filled {n_missing} missing with mean={fill_val:.4g}"})
        elif numeric_strategy == "median":
            fill_val = float(df[col].median())
            df[col].fillna(fill_val, inplace=True)
            log.append({"action": "impute_median", "column": col,
                         "detail": f"Filled {n_missing} missing with median={fill_val:.4g}"})
        elif numeric_strategy == "drop":
            df.dropna(subset=[col], inplace=True)
            log.append({"action": "drop_missing", "column": col,
                         "detail": f"Dropped {n_missing} rows with missing values"})

    for col in cat_cols:
        n_missing = int(df[col].isna().sum())
        if n_missing == 0:
            continue
        df[col].fillna(categorical_fill, inplace=True)
        log.append({"action": "fill_categorical", "column": col,
                     "detail": f"Filled {n_missing} missing with '{categorical_fill}'"})

    for col in date_cols:
        n_missing = int(df[col].isna().sum())
        if n_missing > 0:
            df.dropna(subset=[col], inplace=True)
            log.append({"action": "drop_missing_dates", "column": col,
                         "detail": f"Dropped {n_missing} rows with unparseable dates"})

    # 3 ── remove duplicates ───────────────────────────────────────
    n_before = len(df)
    df.drop_duplicates(subset=dedup_subset, inplace=True)
    n_dupes = n_before - len(df)
    if n_dupes:
        log.append({"action": "remove_duplicates", "column": None,
                     "detail": f"Removed {n_dupes} duplicate rows"
                               + (f" (key: {dedup_subset})" if dedup_subset else "")})

    # 4 ── standardise categoricals ────────────────────────────────
    for col in cat_cols:
        if df[col].dtype == "object" or df[col].dtype.name in ("str", "string"):
            before_nunique = int(df[col].nunique())
            df[col] = df[col].astype(str).str.strip().str.title()
            after_nunique = int(df[col].nunique())
            if after_nunique < before_nunique:
                log.append({"action": "standardise_categorical", "column": col,
                             "detail": f"Title-cased & trimmed; unique values {before_nunique}→{after_nunique}"})

    # 5 ── standardise dates ───────────────────────────────────────
    for col in date_cols:
        if date_format:
            try:
                df[col] = pd.to_datetime(df[col]).dt.strftime(date_format)
                log.append({"action": "format_date", "column": col,
                             "detail": f"Reformatted to {date_format}"})
            except Exception:
                pass

    # 6 ── outlier handling ────────────────────────────────────────
    if outlier_method == "iqr":
        for col in numeric_cols:
            q1 = float(df[col].quantile(0.25))
            q3 = float(df[col].quantile(0.75))
            iqr = q3 - q1
            if iqr == 0:
                continue
            lower = q1 - IQR_FACTOR * iqr
            upper = q3 + IQR_FACTOR * iqr
            n_outliers = int(((df[col] < lower) | (df[col] > upper)).sum())
            if n_outliers:
                df[col] = df[col].clip(lower, upper)
                log.append({"action": "cap_outliers_iqr", "column": col,
                             "detail": f"Capped {n_outliers} outliers to [{lower:.4g}, {upper:.4g}]"})
    elif outlier_method == "zscore":
        for col in numeric_cols:
            mean = float(df[col].mean())
            std = float(df[col].std())
            if std == 0:
                continue
            z = ((df[col] - mean) / std).abs()
            n_outliers = int((z > ZSCORE_THRESHOLD).sum())
            if n_outliers:
                lower = mean - ZSCORE_THRESHOLD * std
                upper = mean + ZSCORE_THRESHOLD * std
                df[col] = df[col].clip(lower, upper)
                log.append({"action": "cap_outliers_zscore", "column": col,
                             "detail": f"Capped {n_outliers} outliers (|z|>{ZSCORE_THRESHOLD})"})

    # 7 ── normalisation / scaling ─────────────────────────────────
    if normalize == "minmax":
        for col in numeric_cols:
            mn, mx = float(df[col].min()), float(df[col].max())
            if mx - mn == 0:
                continue
            df[col] = (df[col] - mn) / (mx - mn)
            log.append({"action": "normalize_minmax", "column": col,
                         "detail": f"Scaled to [0, 1] (original range [{mn:.4g}, {mx:.4g}])"})
    elif normalize == "zscore":
        for col in numeric_cols:
            mean = float(df[col].mean())
            std = float(df[col].std())
            if std == 0:
                continue
            df[col] = (df[col] - mean) / std
            log.append({"action": "normalize_zscore", "column": col,
                         "detail": f"Z-score normalised (μ={mean:.4g}, σ={std:.4g})"})

    # 8 ── final summary ──────────────────────────────────────────
    rows_removed = original_rows - len(df)
    log.append({"action": "summary", "column": None,
                "detail": f"Original: {original_rows} rows × {original_cols} cols → "
                          f"Cleaned: {len(df)} rows × {len(df.columns)} cols "
                          f"({rows_removed} rows removed)"})

    df.reset_index(drop=True, inplace=True)
    return df, log


def get_column_info(df: pd.DataFrame) -> list[dict]:
    """Return column name, dtype-label, nunique, and sample values for UI display."""
    info = []
    for col in df.columns:
        s = df[col].dropna()
        dtype_label = "unknown"
        if pd.api.types.is_numeric_dtype(s):
            dtype_label = "numeric"
        elif pd.api.types.is_datetime64_any_dtype(s):
            dtype_label = "datetime"
        else:
            dtype_label = "categorical"
        info.append({
            "name": col,
            "dtype": dtype_label,
            "nunique": int(s.nunique()) if not s.empty else 0,
            "sample": s.head(3).astype(str).tolist() if not s.empty else [],
            "missing": int(df[col].isna().sum()),
        })
    return info
