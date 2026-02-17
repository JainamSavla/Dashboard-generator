import pandas as pd
import numpy as np
from pathlib import Path

# Thresholds for column classification
CATEGORICAL_UNIQUE_RATIO = 0.3   # if unique/total < 30%, treat as categorical
CATEGORICAL_MAX_UNIQUE = 30      # max unique values to still be categorical
TOP_N_CATEGORIES = 15            # show top N categories in charts
CORRELATION_THRESHOLD = 0.5      # min |r| to generate a scatter plot
MAX_SCATTER_POINTS = 500         # downsample scatter data beyond this
PALETTE = [
    "#6366f1", "#f43f5e", "#10b981", "#f59e0b", "#3b82f6",
    "#8b5cf6", "#ec4899", "#14b8a6", "#ef4444", "#06b6d4",
    "#84cc16", "#a855f7", "#f97316", "#22d3ee", "#e11d48",
]


def classify_columns(df: pd.DataFrame) -> dict:
    """Classify each column as numeric, categorical, or datetime."""
    meta = {}
    for col in df.columns:
        series = df[col].dropna()
        if series.empty:
            meta[col] = {"dtype": "empty", "nunique": 0}
            continue

        # Try datetime first — check string-like dtypes (object in pandas <3, str in pandas 3+)
        if series.dtype == "object" or series.dtype.name in ("str", "string"):
            try:
                parsed = pd.to_datetime(series, dayfirst=False, format="mixed")
                if parsed.notna().sum() > len(series) * 0.7:
                    df[col] = parsed
                    meta[col] = {"dtype": "datetime", "nunique": int(series.nunique()),
                                 "min": str(parsed.min()), "max": str(parsed.max())}
                    continue
            except (ValueError, TypeError):
                pass

        if pd.api.types.is_numeric_dtype(series):
            nunique = int(series.nunique())
            ratio = nunique / len(series) if len(series) > 0 else 1
            # Low-cardinality integers → categorical
            if nunique <= CATEGORICAL_MAX_UNIQUE and ratio < CATEGORICAL_UNIQUE_RATIO:
                meta[col] = {"dtype": "categorical", "nunique": nunique,
                             "top_values": series.value_counts().head(TOP_N_CATEGORIES).to_dict()}
            else:
                meta[col] = {"dtype": "numeric", "nunique": nunique,
                             "mean": float(series.mean()), "std": float(series.std()),
                             "min": float(series.min()), "max": float(series.max())}
        elif pd.api.types.is_datetime64_any_dtype(series):
            meta[col] = {"dtype": "datetime", "nunique": int(series.nunique()),
                         "min": str(series.min()), "max": str(series.max())}
        else:
            nunique = int(series.nunique())
            meta[col] = {"dtype": "categorical", "nunique": nunique,
                         "top_values": series.value_counts().head(TOP_N_CATEGORIES).to_dict()}
    return meta


def _bar_chart(df: pd.DataFrame, col: str, meta: dict, idx: int) -> dict:
    """Bar chart for a categorical column — shows value counts."""
    counts = df[col].value_counts().head(TOP_N_CATEGORIES)
    return {
        "chart_type": "bar",
        "title": f"Distribution of {col}",
        "config": {
            "type": "bar",
            "data": {
                "labels": [str(l) for l in counts.index.tolist()],
                "datasets": [{
                    "label": col,
                    "data": counts.values.tolist(),
                    "backgroundColor": PALETTE[:len(counts)],
                    "borderRadius": 6,
                }],
            },
            "options": _base_options(f"Distribution of {col}"),
        },
    }


def _pie_chart(df: pd.DataFrame, col: str, meta: dict, idx: int) -> dict:
    """Pie/doughnut chart for low-cardinality categorical columns."""
    counts = df[col].value_counts().head(10)
    return {
        "chart_type": "doughnut",
        "title": f"Proportion of {col}",
        "config": {
            "type": "doughnut",
            "data": {
                "labels": [str(l) for l in counts.index.tolist()],
                "datasets": [{
                    "data": counts.values.tolist(),
                    "backgroundColor": PALETTE[:len(counts)],
                    "borderWidth": 2,
                    "borderColor": "#1e1e2e",
                }],
            },
            "options": {
                "responsive": True,
                "maintainAspectRatio": False,
                "plugins": {
                    "title": {"display": True, "text": f"Proportion of {col}",
                              "color": "#e2e8f0", "font": {"size": 14, "weight": "bold"}},
                    "legend": {"position": "right", "labels": {"color": "#cbd5e1", "padding": 12}},
                },
            },
        },
    }


def _histogram(df: pd.DataFrame, col: str, meta: dict, idx: int) -> dict:
    """Histogram for a numeric column."""
    series = df[col].dropna()
    bins = min(30, max(10, int(np.sqrt(len(series)))))
    counts_arr, edges = np.histogram(series, bins=bins)
    labels = [f"{edges[i]:.1f}-{edges[i+1]:.1f}" for i in range(len(counts_arr))]
    return {
        "chart_type": "bar",
        "title": f"Histogram of {col}",
        "config": {
            "type": "bar",
            "data": {
                "labels": labels,
                "datasets": [{
                    "label": col,
                    "data": counts_arr.tolist(),
                    "backgroundColor": PALETTE[idx % len(PALETTE)] + "cc",
                    "borderColor": PALETTE[idx % len(PALETTE)],
                    "borderWidth": 1,
                    "borderRadius": 4,
                    "barPercentage": 1.0,
                    "categoryPercentage": 0.95,
                }],
            },
            "options": _base_options(f"Histogram of {col}"),
        },
    }


def _line_chart(df: pd.DataFrame, date_col: str, num_col: str, idx: int) -> dict:
    """Line chart for a datetime × numeric pair."""
    temp = df[[date_col, num_col]].dropna().sort_values(date_col)
    # Downsample if too many points
    if len(temp) > 500:
        temp = temp.iloc[::len(temp) // 500]
    labels = temp[date_col].astype(str).tolist()
    values = temp[num_col].tolist()
    return {
        "chart_type": "line",
        "title": f"{num_col} over {date_col}",
        "config": {
            "type": "line",
            "data": {
                "labels": labels,
                "datasets": [{
                    "label": num_col,
                    "data": values,
                    "borderColor": PALETTE[idx % len(PALETTE)],
                    "backgroundColor": PALETTE[idx % len(PALETTE)] + "33",
                    "fill": True,
                    "tension": 0.35,
                    "pointRadius": 2,
                }],
            },
            "options": _base_options(f"{num_col} over {date_col}"),
        },
    }


def _scatter_chart(df: pd.DataFrame, col_x: str, col_y: str, corr: float, idx: int) -> dict:
    """Scatter plot for two correlated numeric columns."""
    temp = df[[col_x, col_y]].dropna()
    if len(temp) > MAX_SCATTER_POINTS:
        temp = temp.sample(MAX_SCATTER_POINTS, random_state=42)
    data_points = [{"x": float(r[col_x]), "y": float(r[col_y])} for _, r in temp.iterrows()]
    return {
        "chart_type": "scatter",
        "title": f"{col_x} vs {col_y} (r={corr:.2f})",
        "config": {
            "type": "scatter",
            "data": {
                "datasets": [{
                    "label": f"{col_x} vs {col_y}",
                    "data": data_points,
                    "backgroundColor": PALETTE[idx % len(PALETTE)] + "99",
                    "pointRadius": 4,
                }],
            },
            "options": {
                "responsive": True,
                "maintainAspectRatio": False,
                "plugins": {
                    "title": {"display": True, "text": f"{col_x} vs {col_y} (r={corr:.2f})",
                              "color": "#e2e8f0", "font": {"size": 14, "weight": "bold"}},
                    "legend": {"labels": {"color": "#cbd5e1"}},
                },
                "scales": {
                    "x": {"title": {"display": True, "text": col_x, "color": "#94a3b8"},
                           "ticks": {"color": "#94a3b8"}, "grid": {"color": "#334155"}},
                    "y": {"title": {"display": True, "text": col_y, "color": "#94a3b8"},
                           "ticks": {"color": "#94a3b8"}, "grid": {"color": "#334155"}},
                },
            },
        },
    }


def _summary_stats_chart(df: pd.DataFrame, numeric_cols: list[str]) -> dict | None:
    """Horizontal bar chart comparing means of numeric columns (normalized)."""
    if len(numeric_cols) < 2:
        return None
    means = {c: float(df[c].mean()) for c in numeric_cols[:10]}
    cols = list(means.keys())
    vals = list(means.values())
    return {
        "chart_type": "bar",
        "title": "Numeric Columns — Mean Comparison",
        "config": {
            "type": "bar",
            "data": {
                "labels": cols,
                "datasets": [{
                    "label": "Mean",
                    "data": vals,
                    "backgroundColor": PALETTE[:len(cols)],
                    "borderRadius": 6,
                }],
            },
            "options": {
                **_base_options("Numeric Columns — Mean Comparison"),
                "indexAxis": "y",
            },
        },
    }


def _base_options(title: str) -> dict:
    return {
        "responsive": True,
        "maintainAspectRatio": False,
        "plugins": {
            "title": {"display": True, "text": title,
                      "color": "#e2e8f0", "font": {"size": 14, "weight": "bold"}},
            "legend": {"labels": {"color": "#cbd5e1"}},
        },
        "scales": {
            "x": {"ticks": {"color": "#94a3b8"}, "grid": {"color": "#334155"}},
            "y": {"ticks": {"color": "#94a3b8"}, "grid": {"color": "#334155"}},
        },
    }


def compute_summary_stats(df: pd.DataFrame, col_meta: dict) -> list[dict]:
    """Compute mean, median, min, max, std, Q1, Q3 for numeric columns."""
    numeric_cols = [c for c, m in col_meta.items() if m["dtype"] == "numeric"]
    stats = []
    for col in numeric_cols:
        s = df[col].dropna()
        if s.empty:
            continue
        stats.append({
            "column": col,
            "count": int(s.count()),
            "mean": round(float(s.mean()), 2),
            "median": round(float(s.median()), 2),
            "std": round(float(s.std()), 2),
            "min": round(float(s.min()), 2),
            "max": round(float(s.max()), 2),
            "q1": round(float(s.quantile(0.25)), 2),
            "q3": round(float(s.quantile(0.75)), 2),
            "missing": int(df[col].isna().sum()),
        })
    return stats


def build_custom_chart(file_path: str | Path, chart_type: str,
                       col_x: str, col_y: str | None = None) -> dict:
    """Generate a single chart config from user-selected columns + type."""
    df = pd.read_csv(file_path, low_memory=False)
    df.columns = df.columns.str.strip()
    col_meta = classify_columns(df)

    # Validate columns exist
    if col_x not in df.columns:
        raise ValueError(f"Column '{col_x}' not found")
    if col_y and col_y not in df.columns:
        raise ValueError(f"Column '{col_y}' not found")

    idx = 0
    if chart_type == "bar":
        if col_meta.get(col_x, {}).get("dtype") == "numeric":
            return _histogram(df, col_x, col_meta.get(col_x, {}), idx)
        return _bar_chart(df, col_x, col_meta.get(col_x, {}), idx)
    elif chart_type == "line":
        if col_y:
            return _line_chart(df, col_x, col_y, idx)
        # Single numeric col over index
        series = df[col_x].dropna()
        return {
            "chart_type": "line",
            "title": f"{col_x} Trend",
            "config": {
                "type": "line",
                "data": {
                    "labels": list(range(len(series))),
                    "datasets": [{"label": col_x, "data": series.tolist(),
                                  "borderColor": PALETTE[0], "backgroundColor": PALETTE[0] + "33",
                                  "fill": True, "tension": 0.35, "pointRadius": 2}],
                },
                "options": _base_options(f"{col_x} Trend"),
            },
        }
    elif chart_type in ("pie", "doughnut"):
        return _pie_chart(df, col_x, col_meta.get(col_x, {}), idx)
    elif chart_type == "scatter":
        if not col_y:
            raise ValueError("Scatter plots require two columns")
        temp = df[[col_x, col_y]].dropna()
        corr = float(temp[col_x].corr(temp[col_y])) if len(temp) > 1 else 0
        return _scatter_chart(df, col_x, col_y, corr, idx)
    elif chart_type == "histogram":
        return _histogram(df, col_x, col_meta.get(col_x, {}), idx)
    else:
        raise ValueError(f"Unsupported chart type: {chart_type}")


def analyze_csv(file_path: str | Path, max_rows: int = 500000) -> dict:
    """Main entry: read CSV, classify columns, generate chart configs."""
    df = pd.read_csv(file_path, low_memory=False)
    df.columns = df.columns.str.strip()
    
    # Check row count limit
    if len(df) > max_rows:
        raise ValueError(f"CSV has {len(df):,} rows, exceeding the maximum of {max_rows:,} rows. Please use a smaller file.")

    col_meta = classify_columns(df)
    numeric_cols = [c for c, m in col_meta.items() if m["dtype"] == "numeric"]
    categorical_cols = [c for c, m in col_meta.items() if m["dtype"] == "categorical"]
    datetime_cols = [c for c, m in col_meta.items() if m["dtype"] == "datetime"]

    charts: list[dict] = []
    idx = 0

    # 1. Categorical columns → bar + optional pie
    for col in categorical_cols:
        charts.append(_bar_chart(df, col, col_meta[col], idx)); idx += 1
        if col_meta[col]["nunique"] <= 8:
            charts.append(_pie_chart(df, col, col_meta[col], idx)); idx += 1

    # 2. Numeric columns → histograms
    for col in numeric_cols[:6]:
        charts.append(_histogram(df, col, col_meta[col], idx)); idx += 1

    # 3. Datetime × numeric → line charts
    for dcol in datetime_cols[:2]:
        for ncol in numeric_cols[:3]:
            charts.append(_line_chart(df, dcol, ncol, idx)); idx += 1

    # 4. Numeric correlations → scatter plots (top pairs by |r|)
    if len(numeric_cols) >= 2:
        corr_matrix = df[numeric_cols].corr()
        pairs = []
        for i, c1 in enumerate(numeric_cols):
            for c2 in numeric_cols[i + 1:]:
                r = corr_matrix.loc[c1, c2]
                if not np.isnan(r) and abs(r) >= CORRELATION_THRESHOLD:
                    pairs.append((c1, c2, r))
        pairs.sort(key=lambda x: abs(x[2]), reverse=True)
        for c1, c2, r in pairs[:4]:
            charts.append(_scatter_chart(df, c1, c2, r, idx)); idx += 1

    # 5. Summary comparison
    summary = _summary_stats_chart(df, numeric_cols)
    if summary:
        charts.append(summary)

    # 6. Summary statistics table data
    summary_stats = compute_summary_stats(df, col_meta)

    return {
        "row_count": len(df),
        "col_count": len(df.columns),
        "columns_meta": col_meta,
        "charts": charts,
        "summary_stats": summary_stats,
        "preview": df.head(5).fillna("").to_dict(orient="records"),
    }


# ── Cross-CSV chart builder ─────────────────────────────────────
def build_cross_csv_chart(
    file_path_x: str | Path, col_x: str,
    file_path_y: str | Path, col_y: str,
    chart_type: str = "bar",
    max_rows: int = 500000,
) -> dict:
    """Build a chart using X from one CSV and Y from another (no merge needed).

    Rows are aligned by index (row 0 ↔ row 0, etc.) and
    truncated to the shorter file.
    """
    df_x = pd.read_csv(file_path_x, low_memory=False)
    df_x.columns = df_x.columns.str.strip()
    df_y = pd.read_csv(file_path_y, low_memory=False)
    df_y.columns = df_y.columns.str.strip()
    
    # Check row count limits
    if len(df_x) > max_rows:
        raise ValueError(f"X-axis CSV has {len(df_x):,} rows, exceeding the maximum of {max_rows:,} rows.")
    if len(df_y) > max_rows:
        raise ValueError(f"Y-axis CSV has {len(df_y):,} rows, exceeding the maximum of {max_rows:,} rows.")

    if col_x not in df_x.columns:
        raise ValueError(f"Column '{col_x}' not found in X-axis CSV")
    if col_y not in df_y.columns:
        raise ValueError(f"Column '{col_y}' not found in Y-axis CSV")

    # Align on the shorter length
    n = min(len(df_x), len(df_y))
    sx = df_x[col_x].iloc[:n]
    sy = df_y[col_y].iloc[:n]

    title = f"{col_x} vs {col_y}"
    base_opts = _base_options(title)

    if chart_type == "scatter":
        temp = pd.DataFrame({"x": sx, "y": sy}).dropna()
        if len(temp) > MAX_SCATTER_POINTS:
            temp = temp.sample(MAX_SCATTER_POINTS, random_state=42)
        return {
            "chart_type": "scatter",
            "title": title,
            "config": {
                "type": "scatter",
                "data": {
                    "datasets": [{
                        "label": title,
                        "data": [{"x": float(r.x), "y": float(r.y)} for r in temp.itertuples()],
                        "backgroundColor": PALETTE[0] + "88",
                        "pointRadius": 3,
                    }],
                },
                "options": base_opts,
            },
        }

    # For bar / line: use X values as labels, Y as data
    combined = pd.DataFrame({"x": sx, "y": sy}).dropna()

    # If X is categorical-ish, aggregate Y by X
    x_meta = classify_columns(pd.DataFrame({"x": combined["x"]}))
    is_cat = x_meta.get("x", {}).get("dtype") == "categorical"

    if is_cat:
        agg = combined.groupby("x")["y"].mean()
        if len(agg) > TOP_N_CATEGORIES:
            agg = agg.nlargest(TOP_N_CATEGORIES)
        labels = [str(l) for l in agg.index.tolist()]
        values = agg.tolist()
    else:
        # Use raw aligned values (limit to first 200 for readability)
        subset = combined.head(200)
        labels = [str(v) for v in subset["x"].tolist()]
        values = subset["y"].tolist()

    dataset = {
        "label": col_y,
        "data": values,
        "backgroundColor": [PALETTE[i % len(PALETTE)] + "cc" for i in range(len(values))],
        "borderColor": PALETTE[0],
        "borderWidth": 1,
    }

    if chart_type == "line":
        dataset["fill"] = False
        dataset["tension"] = 0.35
        dataset["pointRadius"] = 2
        dataset["backgroundColor"] = PALETTE[0] + "33"

    cfg_type = chart_type if chart_type in ("bar", "line", "pie", "doughnut") else "bar"

    if cfg_type in ("pie", "doughnut"):
        return {
            "chart_type": cfg_type,
            "title": title,
            "config": {
                "type": cfg_type,
                "data": {"labels": labels, "datasets": [dataset]},
                "options": {
                    **base_opts,
                    "plugins": {**base_opts.get("plugins", {}),
                                "legend": {"position": "right",
                                           "labels": {"color": "#cbd5e1"}}},
                },
            },
        }

    return {
        "chart_type": cfg_type,
        "title": title,
        "config": {
            "type": cfg_type,
            "data": {"labels": labels, "datasets": [dataset]},
            "options": base_opts,
        },
    }
