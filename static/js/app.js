/* ── State ───────────────────────────────────────────────────── */
let selectedFiles = [];
let currentDashboardId = null;
const chartInstances = [];

/* ── DOM refs ────────────────────────────────────────────────── */
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

/* ── Init (runs on index.html only) ──────────────────────────── */
document.addEventListener("DOMContentLoaded", () => {
    const dropZone = $("#drop-zone");
    const fileInput = $("#file-input");
    const uploadBtn = $("#upload-btn");

    if (!dropZone) return; // dashboard.html page

    // Drag & drop
    ["dragenter", "dragover"].forEach((e) =>
        dropZone.addEventListener(e, (ev) => { ev.preventDefault(); dropZone.classList.add("drag-over"); })
    );
    ["dragleave", "drop"].forEach((e) =>
        dropZone.addEventListener(e, (ev) => { ev.preventDefault(); dropZone.classList.remove("drag-over"); })
    );
    dropZone.addEventListener("drop", (ev) => {
        const files = [...ev.dataTransfer.files].filter((f) => f.name.toLowerCase().endsWith(".csv"));
        addFiles(files);
    });

    fileInput.addEventListener("change", () => {
        addFiles([...fileInput.files]);
        fileInput.value = "";
    });

    uploadBtn.addEventListener("click", handleUpload);

    // Load saved dashboards
    loadDashboards();
});

/* ── File management ─────────────────────────────────────────── */
function addFiles(files) {
    files.forEach((f) => {
        if (!selectedFiles.find((sf) => sf.name === f.name && sf.size === f.size)) {
            selectedFiles.push(f);
        }
    });
    renderFileList();
}

function removeFile(index) {
    selectedFiles.splice(index, 1);
    renderFileList();
}

function renderFileList() {
    const container = $("#file-list");
    const btn = $("#upload-btn");
    container.innerHTML = "";
    btn.disabled = selectedFiles.length === 0;

    selectedFiles.forEach((f, i) => {
        const tag = document.createElement("span");
        tag.className = "file-tag";
        tag.innerHTML = `
            <svg class="w-3.5 h-3.5 text-indigo-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"/></svg>
            ${f.name} <span class="text-slate-600">(${formatSize(f.size)})</span>
            <span class="remove" onclick="event.stopPropagation(); removeFile(${i})">&times;</span>
        `;
        container.appendChild(tag);
    });
}

/* ── Upload handler ──────────────────────────────────────────── */
async function handleUpload() {
    if (selectedFiles.length === 0) return;

    const formData = new FormData();
    selectedFiles.forEach((f) => formData.append("files", f));

    const name = $("#dashboard-name").value.trim();
    if (name) formData.append("dashboard_name", name);

    // Show loading
    $("#upload-section").classList.add("hidden");
    $("#loading").classList.remove("hidden");
    $("#preview-section").classList.add("hidden");

    try {
        const res = await fetch("/api/upload", { method: "POST", body: formData });
        if (!res.ok) {
            const err = await res.json();
            throw new Error(err.detail || "Upload failed");
        }
        const data = await res.json();
        currentDashboardId = data.dashboard_id;

        // Show preview
        showPreview(data);
        toast("Dashboard generated!", "success");
        loadDashboards();
    } catch (err) {
        toast(err.message, "error");
        $("#upload-section").classList.remove("hidden");
    } finally {
        $("#loading").classList.add("hidden");
        selectedFiles = [];
        renderFileList();
        $("#dashboard-name").value = "";
    }
}

/* ── Show dashboard preview ──────────────────────────────────── */
function showPreview(data) {
    $("#upload-section").classList.remove("hidden");
    $("#preview-section").classList.remove("hidden");
    $("#preview-title").textContent = data.name;

    // Data preview table
    const previewDiv = $("#data-preview");
    if (data.csv_files && data.csv_files.length > 0 && data.csv_files[0].preview) {
        const rows = data.csv_files[0].preview;
        const cols = Object.keys(rows[0] || {});
        previewDiv.innerHTML = `
            <div class="bg-slate-900 rounded-xl border border-slate-800 overflow-hidden mb-2">
                <div class="px-4 py-2 border-b border-slate-800 flex items-center gap-2">
                    <span class="text-sm font-medium text-slate-300">Data Preview</span>
                    <span class="text-xs text-slate-600">${data.csv_files[0].filename} · ${data.csv_files[0].rows.toLocaleString()} rows × ${data.csv_files[0].cols} columns</span>
                </div>
                <div class="overflow-x-auto max-h-48">
                    <table class="preview-table">
                        <thead><tr>${cols.map((c) => `<th>${esc(c)}</th>`).join("")}</tr></thead>
                        <tbody>${rows.map((r) => `<tr>${cols.map((c) => `<td>${esc(String(r[c] ?? ""))}</td>`).join("")}</tr>`).join("")}</tbody>
                    </table>
                </div>
            </div>`;
    } else {
        previewDiv.innerHTML = "";
    }

    renderCharts(data.charts, "#charts-grid");
}

/* ── Load single dashboard (dashboard.html) ──────────────────── */
async function loadSingleDashboard(dashId) {
    currentDashboardId = dashId;
    try {
        const res = await fetch(`/api/dashboards/${dashId}`);
        if (!res.ok) throw new Error("Dashboard not found");
        const data = await res.json();

        // Populate header
        $("#dash-title").textContent = data.name;
        $("#dash-meta").textContent = `Created ${formatDate(data.created_at)} · ${data.charts.length} charts`;

        // CSV info cards
        const infoDiv = $("#csv-info");
        infoDiv.innerHTML = "";
        (data.csv_files || []).forEach((cf) => {
            const meta = typeof cf.columns_meta === "string" ? JSON.parse(cf.columns_meta) : cf.columns_meta;
            const types = Object.values(meta || {});
            const numericCount = types.filter((t) => t.dtype === "numeric").length;
            const catCount = types.filter((t) => t.dtype === "categorical").length;
            const dateCount = types.filter((t) => t.dtype === "datetime").length;

            infoDiv.innerHTML += `
                <div class="stat-badge">
                    <div class="text-sm text-indigo-400 font-medium mb-2">${esc(cf.original_filename)}</div>
                    <div class="flex justify-around">
                        <div><div class="value">${cf.row_count?.toLocaleString() || "?"}</div><div class="label">Rows</div></div>
                        <div><div class="value">${cf.col_count || "?"}</div><div class="label">Columns</div></div>
                    </div>
                    <div class="text-xs text-slate-500 mt-2">
                        ${numericCount} numeric · ${catCount} categorical · ${dateCount} datetime
                    </div>
                </div>`;
        });
        infoDiv.classList.remove("hidden");

        // Charts
        const chartsGrid = $("#charts-grid");
        chartsGrid.classList.remove("hidden");
        renderCharts(data.charts, "#charts-grid");
    } catch (err) {
        toast(err.message, "error");
    } finally {
        $("#loading").classList.add("hidden");
    }
}

/* ── Render charts into a grid ───────────────────────────────── */
function renderCharts(charts, gridSelector) {
    const grid = $(gridSelector);
    grid.innerHTML = "";

    // Destroy existing chart instances
    chartInstances.forEach((c) => c.destroy());
    chartInstances.length = 0;

    charts.forEach((chart, i) => {
        const cfg = chart.config || chart;
        const card = document.createElement("div");
        card.className = "chart-card";

        // Make doughnut/pie cards span full width on their own
        if (cfg.type === "scatter") {
            card.classList.add("lg:col-span-1");
        }

        const canvas = document.createElement("canvas");
        canvas.id = `chart-${i}`;
        card.appendChild(canvas);
        grid.appendChild(card);

        const instance = new Chart(canvas.getContext("2d"), JSON.parse(JSON.stringify(cfg)));
        chartInstances.push(instance);
    });
}

/* ── Load dashboards list ────────────────────────────────────── */
async function loadDashboards() {
    const listDiv = $("#dashboards-list");
    const emptyMsg = $("#no-dashboards");
    if (!listDiv) return;

    try {
        const res = await fetch("/api/dashboards");
        const dashboards = await res.json();

        if (dashboards.length === 0) {
            listDiv.innerHTML = "";
            emptyMsg?.classList.remove("hidden");
            return;
        }

        emptyMsg?.classList.add("hidden");
        listDiv.innerHTML = dashboards
            .map(
                (d) => `
            <div class="dash-card" onclick="window.location='/dashboard/${d.id}'">
                <div class="flex items-start justify-between mb-3">
                    <h3 class="font-semibold text-white text-sm truncate flex-1">${esc(d.name)}</h3>
                    <span class="text-xs text-slate-600 ml-2 shrink-0">${formatDate(d.created_at)}</span>
                </div>
                <div class="flex items-center gap-3 text-xs text-slate-500">
                    <span class="flex items-center gap-1">
                        <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2z"/></svg>
                        ${d.chart_count} charts
                    </span>
                    <span class="flex items-center gap-1">
                        <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"/></svg>
                        ${esc(d.csv_files || "—")}
                    </span>
                </div>
            </div>`
            )
            .join("");
    } catch (err) {
        console.error("Failed to load dashboards:", err);
    }
}

/* ── Export ───────────────────────────────────────────────────── */
function exportDashboard(format) {
    if (!currentDashboardId) return;
    _doExport(currentDashboardId, format);
}

function exportCurrent(format) {
    const dashId = window.location.pathname.split("/").pop();
    _doExport(dashId, format);
}

function _doExport(dashId, format) {
    if (format === "pdf") {
        toast("Preparing PDF — uses browser print", "success");
        window.print();
        return;
    }
    // Excel or HTML — server-side generation
    const url = `/api/dashboards/${dashId}/export/${format}`;
    const a = document.createElement("a");
    a.href = url;
    a.download = "";
    document.body.appendChild(a);
    a.click();
    a.remove();
    toast(`Downloading ${format.toUpperCase()}...`, "success");
}

/* ── Delete dashboard ────────────────────────────────────────── */
async function deleteCurrent() {
    const dashId = window.location.pathname.split("/").pop();
    if (!confirm("Delete this dashboard permanently?")) return;

    try {
        const res = await fetch(`/api/dashboards/${dashId}`, { method: "DELETE" });
        if (!res.ok) throw new Error("Delete failed");
        toast("Dashboard deleted", "success");
        setTimeout(() => (window.location.href = "/"), 800);
    } catch (err) {
        toast(err.message, "error");
    }
}

/* ── Utilities ───────────────────────────────────────────────── */
function toast(msg, type = "success") {
    const el = document.createElement("div");
    el.className = `toast ${type}`;
    el.textContent = msg;
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 3200);
}

function esc(str) {
    const d = document.createElement("div");
    d.textContent = str;
    return d.innerHTML;
}

function formatSize(bytes) {
    if (bytes < 1024) return bytes + " B";
    if (bytes < 1048576) return (bytes / 1024).toFixed(1) + " KB";
    return (bytes / 1048576).toFixed(1) + " MB";
}

function formatDate(dateStr) {
    if (!dateStr) return "";
    const d = new Date(dateStr);
    return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}
