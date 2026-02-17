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
from csv_analyzer import analyze_csv

BASE_DIR = Path(__file__).parent
UPLOADS_DIR = BASE_DIR / "uploads"
UPLOADS_DIR.mkdir(exist_ok=True)

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

    for upload_file in files:
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
        db.save_charts(dashboard_id, csv_id, result["charts"])

        csv_infos.append({
            "id": csv_id,
            "filename": upload_file.filename,
            "rows": result["row_count"],
            "cols": result["col_count"],
            "preview": result["preview"],
        })
        all_charts.extend(result["charts"])

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


if __name__ == "__main__":
    import uvicorn
    uvicorn.run("main:app", host="0.0.0.0", port=8000, reload=True)
