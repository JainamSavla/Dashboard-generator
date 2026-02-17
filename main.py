import json
import uuid
import shutil
from pathlib import Path
from io import BytesIO

from fastapi import FastAPI, UploadFile, File, Request, Response, HTTPException, Form
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse, StreamingResponse, HTMLResponse
import pandas as pd

import database as db
from csv_analyzer import analyze_csv, build_custom_chart, compute_summary_stats, classify_columns
from data_cleaner import clean_dataframe, get_column_info
from data_merger import merge_dataframes, preview_merge, find_common_columns, apply_column_mapping

BASE_DIR = Path(__file__).parent
UPLOADS_DIR = BASE_DIR / "uploads"
UPLOADS_DIR.mkdir(exist_ok=True)
MERGED_DIR = BASE_DIR / "merged"
MERGED_DIR.mkdir(exist_ok=True)

app = FastAPI(title="Dashboard Generator")
app.mount("/static", StaticFiles(directory=str(BASE_DIR / "static")), name="static")


# ── Session helper ──────────────────────────────────────────────
def _session(request: Request, response: Response) -> str:
    sid = request.cookies.get("session_id")
    sid = db.get_or_create_session(sid)
    response.set_cookie("session_id", sid, max_age=60 * 60 * 24 * 365, httponly=True, samesite="lax")
    return sid


# ── Startup ─────────────────────────────────────────────────────
@app.on_event("startup")
def startup():
    db.init_db()


# ── Pages ───────────────────────────────────────────────────────
@app.get("/", response_class=FileResponse)
async def index():
    return FileResponse(str(BASE_DIR / "static" / "index.html"))


@app.get("/dashboard/{dashboard_id}", response_class=FileResponse)
async def dashboard_page(dashboard_id: str):
    return FileResponse(str(BASE_DIR / "static" / "dashboard.html"))


@app.get("/dashboard/{dashboard_id}/merge", response_class=FileResponse)
async def merge_page(dashboard_id: str):
    return FileResponse(str(BASE_DIR / "static" / "merge.html"))


# ── API: Upload CSV & generate dashboard ────────────────────────
@app.post("/api/upload")
async def upload_csv(
    request: Request,
    response: Response,
    files: list[UploadFile] = File(...),
    dashboard_name: str = Form(None),
):
    sid = _session(request, response)

    if not files:
        raise HTTPException(400, "No files uploaded")

    # Auto-name dashboard
    name = dashboard_name or f"Dashboard {pd.Timestamp.now().strftime('%b %d, %Y %H:%M')}"
    dashboard_id = db.create_dashboard(sid, name)

    all_charts = []
    csv_infos = []

    # Parse optional roles JSON from form data
    roles_raw = None
    form = await request.form()
    roles_str = form.get("roles")
    if roles_str:
        try:
            roles_raw = json.loads(roles_str)
        except Exception:
            roles_raw = None

    for i, upload_file in enumerate(files):
        if not upload_file.filename.lower().endswith(".csv"):
            raise HTTPException(400, f"Only CSV files allowed: {upload_file.filename}")

        stored_name = f"{uuid.uuid4().hex}_{upload_file.filename}"
        file_path = UPLOADS_DIR / stored_name
        with open(file_path, "wb") as f:
            shutil.copyfileobj(upload_file.file, f)

        try:
            result = analyze_csv(str(file_path))
        except Exception as e:
            file_path.unlink(missing_ok=True)
            raise HTTPException(422, f"Error analysing {upload_file.filename}: {str(e)}")

        csv_id = db.save_csv_metadata(
            dashboard_id, upload_file.filename, stored_name,
            str(file_path), result["row_count"], result["col_count"], result["columns_meta"],
        )
        saved_charts = db.save_charts(dashboard_id, csv_id, result["charts"])

        # Save CSV role
        role = "primary" if i == 0 else "secondary"
        if roles_raw and isinstance(roles_raw, list) and i < len(roles_raw):
            role = roles_raw[i].get("role", role)
        db.save_csv_role(csv_id, role, i)

        csv_infos.append({
            "id": csv_id,
            "filename": upload_file.filename,
            "role": role,
            "rows": result["row_count"],
            "cols": result["col_count"],
            "preview": result["preview"],
            "columns_meta": result["columns_meta"],
            "summary_stats": result["summary_stats"],
        })
        all_charts.extend(saved_charts)

    return {
        "dashboard_id": dashboard_id,
        "name": name,
        "csv_files": csv_infos,
        "charts": all_charts,
    }


# ── API: List dashboards ────────────────────────────────────────
@app.get("/api/dashboards")
async def list_dashboards(request: Request, response: Response):
    sid = _session(request, response)
    return db.get_dashboards(sid)


# ── API: Get single dashboard ───────────────────────────────────
@app.get("/api/dashboards/{dashboard_id}")
async def get_dashboard(dashboard_id: str, request: Request, response: Response):
    sid = _session(request, response)
    dash = db.get_dashboard(dashboard_id, sid)
    if not dash:
        raise HTTPException(404, "Dashboard not found")
    return dash


# ── API: Delete dashboard ───────────────────────────────────────
@app.delete("/api/dashboards/{dashboard_id}")
async def delete_dashboard(dashboard_id: str, request: Request, response: Response):
    sid = _session(request, response)
    # Remove CSV files from disk
    dash = db.get_dashboard(dashboard_id, sid)
    if dash:
        for cf in dash.get("csv_files", []):
            Path(cf["file_path"]).unlink(missing_ok=True)
    if not db.delete_dashboard(dashboard_id, sid):
        raise HTTPException(404, "Dashboard not found")
    return {"ok": True}


# ── API: Add custom chart to dashboard ───────────────────────────
@app.post("/api/dashboards/{dashboard_id}/charts")
async def add_custom_chart(dashboard_id: str, request: Request, response: Response):
    sid = _session(request, response)
    dash = db.get_dashboard(dashboard_id, sid)
    if not dash:
        raise HTTPException(404, "Dashboard not found")

    body = await request.json()
    chart_type = body.get("chart_type", "bar")
    col_x = body.get("col_x")
    col_y = body.get("col_y")
    csv_file_id = body.get("csv_file_id")

    if not col_x:
        raise HTTPException(400, "col_x is required")

    # Find the CSV file
    csv_file = None
    for cf in dash["csv_files"]:
        if csv_file_id and cf["id"] == csv_file_id:
            csv_file = cf
            break
    if not csv_file:
        csv_file = dash["csv_files"][0] if dash["csv_files"] else None
    if not csv_file:
        raise HTTPException(400, "No CSV file found")

    try:
        chart = build_custom_chart(csv_file["file_path"], chart_type, col_x, col_y)
    except Exception as e:
        raise HTTPException(422, str(e))

    saved = db.save_charts(dashboard_id, csv_file["id"], [chart])
    # Return the saved chart with its DB id and csv_file_id
    return saved[0] if saved else chart


# ── API: Get summary stats for a dashboard ───────────────────────
@app.get("/api/dashboards/{dashboard_id}/summary")
async def get_summary(dashboard_id: str, request: Request, response: Response):
    sid = _session(request, response)
    dash = db.get_dashboard(dashboard_id, sid)
    if not dash:
        raise HTTPException(404)

    all_stats = []
    for cf in dash["csv_files"]:
        df = pd.read_csv(cf["file_path"], low_memory=False)
        df.columns = df.columns.str.strip()
        meta = classify_columns(df)
        stats = compute_summary_stats(df, meta)
        all_stats.append({
            "filename": cf["original_filename"],
            "csv_file_id": cf["id"],
            "stats": stats,
        })
    return all_stats


# ── API: Delete a single chart ───────────────────────────────────
@app.delete("/api/dashboards/{dashboard_id}/charts/{chart_id}")
async def delete_chart_endpoint(dashboard_id: str, chart_id: str,
                                request: Request, response: Response):
    sid = _session(request, response)
    dash = db.get_dashboard(dashboard_id, sid)
    if not dash:
        raise HTTPException(404, "Dashboard not found")
    if not db.delete_chart(chart_id, dashboard_id):
        raise HTTPException(404, "Chart not found")
    return {"ok": True}


# ── API: Rename a chart ──────────────────────────────────────────
@app.patch("/api/dashboards/{dashboard_id}/charts/{chart_id}")
async def rename_chart_endpoint(dashboard_id: str, chart_id: str,
                                request: Request, response: Response):
    sid = _session(request, response)
    dash = db.get_dashboard(dashboard_id, sid)
    if not dash:
        raise HTTPException(404, "Dashboard not found")
    body = await request.json()
    new_title = body.get("title", "").strip()
    if not new_title:
        raise HTTPException(400, "title is required")
    if not db.rename_chart(chart_id, dashboard_id, new_title):
        raise HTTPException(404, "Chart not found")
    return {"ok": True, "title": new_title}


# ── API: Download individual CSV file ────────────────────────────
@app.get("/api/dashboards/{dashboard_id}/csv/{csv_file_id}/download")
async def download_csv(dashboard_id: str, csv_file_id: str,
                       request: Request, response: Response):
    sid = _session(request, response)
    dash = db.get_dashboard(dashboard_id, sid)
    if not dash:
        raise HTTPException(404, "Dashboard not found")
    csv_file = next((cf for cf in dash["csv_files"] if cf["id"] == csv_file_id), None)
    if not csv_file:
        raise HTTPException(404, "CSV file not found")
    path = Path(csv_file["file_path"])
    if not path.exists():
        raise HTTPException(404, "File not found on disk")
    return FileResponse(str(path), filename=csv_file["original_filename"],
                        media_type="text/csv")


# ── API: Rename dashboard ───────────────────────────────────────
@app.patch("/api/dashboards/{dashboard_id}")
async def rename_dashboard(dashboard_id: str, request: Request, response: Response):
    sid = _session(request, response)
    body = await request.json()
    new_name = body.get("name", "").strip()
    if not new_name:
        raise HTTPException(400, "Name required")
    if not db.rename_dashboard(dashboard_id, sid, new_name):
        raise HTTPException(404, "Dashboard not found")
    return {"ok": True}


# ── API: Export as Excel ─────────────────────────────────────────
@app.get("/api/dashboards/{dashboard_id}/export/excel")
async def export_excel(dashboard_id: str, request: Request, response: Response):
    sid = _session(request, response)
    dash = db.get_dashboard(dashboard_id, sid)
    if not dash:
        raise HTTPException(404)

    buf = BytesIO()
    with pd.ExcelWriter(buf, engine="openpyxl") as writer:
        for cf in dash["csv_files"]:
            df = pd.read_csv(cf["file_path"])
            sheet_name = cf["original_filename"][:31]  # Excel 31-char limit
            df.to_excel(writer, index=False, sheet_name=sheet_name)

            # Add summary sheet
            summary = df.describe(include="all").reset_index()
            summary.to_excel(writer, index=False, sheet_name=f"Stats-{sheet_name[:25]}")

    buf.seek(0)
    headers = {"Content-Disposition": f'attachment; filename="{dash["name"]}.xlsx"'}
    return StreamingResponse(buf, media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                             headers=headers)


# ── API: Export as standalone HTML ───────────────────────────────
@app.get("/api/dashboards/{dashboard_id}/export/html")
async def export_html(dashboard_id: str, request: Request, response: Response):
    sid = _session(request, response)
    dash = db.get_dashboard(dashboard_id, sid)
    if not dash:
        raise HTTPException(404)

    charts_json = json.dumps([c["config"] for c in dash["charts"]])
    html = f"""<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>{dash["name"]}</title>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4"></script>
<style>
  *{{margin:0;padding:0;box-sizing:border-box}}
  body{{background:#0f172a;color:#e2e8f0;font-family:system-ui,sans-serif;padding:2rem}}
  h1{{text-align:center;margin-bottom:2rem;font-size:1.8rem}}
  .grid{{display:grid;grid-template-columns:repeat(auto-fit,minmax(480px,1fr));gap:1.5rem}}
  .card{{background:#1e293b;border-radius:12px;padding:1.2rem;height:370px}}
  canvas{{width:100%!important;height:100%!important}}
</style></head><body>
<h1>{dash["name"]}</h1><div class="grid" id="g"></div>
<script>
const charts={charts_json};
const g=document.getElementById('g');
charts.forEach((cfg,i)=>{{
  const d=document.createElement('div');d.className='card';
  const c=document.createElement('canvas');c.id='c'+i;
  d.appendChild(c);g.appendChild(d);
  new Chart(c.getContext('2d'),cfg);
}});
</script></body></html>"""

    headers = {"Content-Disposition": f'attachment; filename="{dash["name"]}.html"'}
    return HTMLResponse(content=html, headers=headers)


# ── API: Clean a CSV ─────────────────────────────────────────────
@app.post("/api/dashboards/{dashboard_id}/clean/{csv_file_id}")
async def clean_csv_endpoint(dashboard_id: str, csv_file_id: str,
                             request: Request, response: Response):
    sid = _session(request, response)
    dash = db.get_dashboard(dashboard_id, sid)
    if not dash:
        raise HTTPException(404, "Dashboard not found")

    csv_file = next((cf for cf in dash["csv_files"] if cf["id"] == csv_file_id), None)
    if not csv_file:
        raise HTTPException(404, "CSV file not found")

    body = await request.json() if request.headers.get("content-type") == "application/json" else {}
    numeric_strategy = body.get("numeric_strategy", "median")
    categorical_fill = body.get("categorical_fill", "Unknown")
    outlier_method = body.get("outlier_method", "iqr")
    normalize = body.get("normalize", None)

    try:
        df = pd.read_csv(csv_file["file_path"], low_memory=False)
        cleaned_df, log = clean_dataframe(
            df,
            numeric_strategy=numeric_strategy,
            categorical_fill=categorical_fill,
            outlier_method=outlier_method,
            normalize=normalize,
        )
        # Save cleaned CSV back
        cleaned_df.to_csv(csv_file["file_path"], index=False)
        col_info = get_column_info(cleaned_df)
    except Exception as e:
        raise HTTPException(422, str(e))

    return {
        "csv_file_id": csv_file_id,
        "rows": len(cleaned_df),
        "cols": len(cleaned_df.columns),
        "cleaning_log": log,
        "columns_info": col_info,
        "preview": cleaned_df.head(5).fillna("").to_dict(orient="records"),
    }


# ── API: Clean ALL CSVs in a dashboard ───────────────────────────
@app.post("/api/dashboards/{dashboard_id}/clean-all")
async def clean_all_csvs(dashboard_id: str, request: Request, response: Response):
    sid = _session(request, response)
    dash = db.get_dashboard(dashboard_id, sid)
    if not dash:
        raise HTTPException(404, "Dashboard not found")

    body = await request.json() if request.headers.get("content-type") == "application/json" else {}
    results = []

    for cf in dash["csv_files"]:
        try:
            df = pd.read_csv(cf["file_path"], low_memory=False)
            cleaned_df, log = clean_dataframe(
                df,
                numeric_strategy=body.get("numeric_strategy", "median"),
                categorical_fill=body.get("categorical_fill", "Unknown"),
                outlier_method=body.get("outlier_method", "iqr"),
                normalize=body.get("normalize", None),
            )
            cleaned_df.to_csv(cf["file_path"], index=False)
            col_info = get_column_info(cleaned_df)
            results.append({
                "csv_file_id": cf["id"],
                "filename": cf["original_filename"],
                "rows": len(cleaned_df),
                "cols": len(cleaned_df.columns),
                "cleaning_log": log,
                "columns_info": col_info,
            })
        except Exception as e:
            results.append({
                "csv_file_id": cf["id"],
                "filename": cf["original_filename"],
                "error": str(e),
            })

    return {"results": results}


# ── API: Get columns for all CSVs (for merge UI) ────────────────
@app.get("/api/dashboards/{dashboard_id}/columns")
async def get_all_columns(dashboard_id: str, request: Request, response: Response):
    sid = _session(request, response)
    dash = db.get_dashboard(dashboard_id, sid)
    if not dash:
        raise HTTPException(404)

    files_info = []
    for cf in dash["csv_files"]:
        df = pd.read_csv(cf["file_path"], low_memory=False)
        df.columns = df.columns.str.strip()
        col_info = get_column_info(df)
        files_info.append({
            "csv_file_id": cf["id"],
            "filename": cf["original_filename"],
            "columns": col_info,
        })

    common = []
    if len(dash["csv_files"]) >= 2:
        dfs = [pd.read_csv(cf["file_path"], low_memory=False) for cf in dash["csv_files"]]
        for d in dfs:
            d.columns = d.columns.str.strip()
        common = find_common_columns(dfs)

    return {"files": files_info, "common_columns": common}


# ── API: Preview merge ───────────────────────────────────────────
@app.post("/api/dashboards/{dashboard_id}/merge/preview")
async def merge_preview_endpoint(dashboard_id: str, request: Request, response: Response):
    sid = _session(request, response)
    dash = db.get_dashboard(dashboard_id, sid)
    if not dash:
        raise HTTPException(404)

    body = await request.json()
    merge_keys = body.get("merge_keys", [])
    how = body.get("how", "inner")
    column_mappings = body.get("column_mappings")  # list of dicts

    if len(dash["csv_files"]) < 2:
        raise HTTPException(400, "Need at least 2 CSVs to merge")
    if not merge_keys:
        raise HTTPException(400, "merge_keys required")

    dfs = []
    for cf in dash["csv_files"]:
        df = pd.read_csv(cf["file_path"], low_memory=False)
        df.columns = df.columns.str.strip()
        dfs.append(df)

    # Apply column mappings for preview
    mapped = []
    for i, df in enumerate(dfs):
        mapping = (column_mappings[i] if column_mappings and i < len(column_mappings) else {})
        mapped.append(apply_column_mapping(df, mapping))

    # For preview, merge first two
    result = preview_merge(mapped[0], mapped[1], merge_keys, how)
    return result


# ── API: Execute merge ───────────────────────────────────────────
@app.post("/api/dashboards/{dashboard_id}/merge")
async def merge_csvs(dashboard_id: str, request: Request, response: Response):
    sid = _session(request, response)
    dash = db.get_dashboard(dashboard_id, sid)
    if not dash:
        raise HTTPException(404)

    body = await request.json()
    merge_keys = body.get("merge_keys", [])
    how = body.get("how", "inner")
    column_mappings = body.get("column_mappings")  # list of dicts, one per csv

    if len(dash["csv_files"]) < 2:
        raise HTTPException(400, "Need at least 2 CSVs to merge")
    if not merge_keys:
        raise HTTPException(400, "merge_keys required")

    # Load all CSVs
    dfs = []
    all_cleaning_logs = []
    for cf in dash["csv_files"]:
        df = pd.read_csv(cf["file_path"], low_memory=False)
        df.columns = df.columns.str.strip()
        dfs.append(df)

    # Merge
    try:
        merged_df, merge_log = merge_dataframes(
            dfs, merge_keys, how=how,
            column_mappings=column_mappings,
        )
    except Exception as e:
        raise HTTPException(422, str(e))

    # Save merged CSV
    merged_filename = f"{uuid.uuid4().hex}_merged.csv"
    merged_path = MERGED_DIR / merged_filename
    merged_df.to_csv(str(merged_path), index=False)

    # Get column info
    col_info = get_column_info(merged_df)

    # Save merge session to DB
    merge_id = db.save_merge_session(
        dashboard_id=dashboard_id,
        merge_keys=merge_keys,
        join_type=how,
        column_mappings=column_mappings,
        cleaning_log=all_cleaning_logs,
        merge_log=merge_log,
        merged_file_path=str(merged_path),
        row_count=len(merged_df),
        col_count=len(merged_df.columns),
        columns_info=col_info,
    )

    # Also save merged CSV as a csv_file so charts can reference it
    merged_csv_id = db.save_csv_metadata(
        dashboard_id, "merged_data.csv", merged_filename,
        str(merged_path), len(merged_df), len(merged_df.columns),
        classify_columns(merged_df),
    )

    # Auto-generate charts on merged data
    try:
        result = analyze_csv(str(merged_path))
        saved_charts = db.save_charts(dashboard_id, merged_csv_id, result["charts"])
        merged_charts = saved_charts
    except Exception:
        merged_charts = []

    return {
        "merge_id": merge_id,
        "merged_csv_id": merged_csv_id,
        "rows": len(merged_df),
        "cols": len(merged_df.columns),
        "columns_info": col_info,
        "merge_log": merge_log,
        "charts": merged_charts,
        "preview": merged_df.head(10).fillna("").to_dict(orient="records"),
    }


# ── API: Get merge sessions for a dashboard ──────────────────────
@app.get("/api/dashboards/{dashboard_id}/merges")
async def get_merges(dashboard_id: str, request: Request, response: Response):
    sid = _session(request, response)
    dash = db.get_dashboard(dashboard_id, sid)
    if not dash:
        raise HTTPException(404)
    return db.get_merge_sessions(dashboard_id)


# ── API: Create chart from merged data ───────────────────────────
@app.post("/api/merges/{merge_id}/charts")
async def add_chart_from_merge(merge_id: str, request: Request, response: Response):
    sid = _session(request, response)
    merge_session = db.get_merge_session(merge_id)
    if not merge_session:
        raise HTTPException(404, "Merge session not found")

    body = await request.json()
    chart_type = body.get("chart_type", "bar")
    col_x = body.get("col_x")
    col_y = body.get("col_y")

    if not col_x:
        raise HTTPException(400, "col_x is required")

    try:
        chart = build_custom_chart(merge_session["merged_file_path"], chart_type, col_x, col_y)
    except Exception as e:
        raise HTTPException(422, str(e))

    return chart


# ── API: Export merged data as CSV ───────────────────────────────
@app.get("/api/merges/{merge_id}/export/csv")
async def export_merged_csv(merge_id: str, request: Request, response: Response):
    merge_session = db.get_merge_session(merge_id)
    if not merge_session:
        raise HTTPException(404)
    path = Path(merge_session["merged_file_path"])
    if not path.exists():
        raise HTTPException(404, "Merged file not found")
    return FileResponse(str(path), filename="merged_data.csv",
                        media_type="text/csv")


if __name__ == "__main__":
    import uvicorn
    uvicorn.run("main:app", host="0.0.0.0", port=8000, reload=True)
