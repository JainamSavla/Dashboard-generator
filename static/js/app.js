/* ── State ───────────────────────────────────────────────────── */
let selectedFiles = [];
let currentDashboardId = null;
const chartInstances = [];      // {instance, originalConfig, canvasId, cardId}
let dashboardData = null;       // full dashboard data for custom chart building

/* ── DOM refs ────────────────────────────────────────────────── */
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

/* compatible chart types for switching */
const SWITCHABLE_TYPES = ["bar", "line", "pie", "doughnut", "polarArea", "radar"];
const POINT_CHART_TYPES = ["scatter", "bubble"];

/* ── Init (runs on index.html only) ──────────────────────────── */
document.addEventListener("DOMContentLoaded", () => {
    const dropZone = $("#drop-zone");
    const fileInput = $("#file-input");
    const uploadBtn = $("#upload-btn");

    if (!dropZone) return;

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
        dashboardData = data;

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

/* ── Show dashboard preview (index.html) ─────────────────────── */
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

    // Summary stats
    const summaryDiv = $("#summary-section");
    if (summaryDiv && data.csv_files) {
        renderSummaryStats(data.csv_files, summaryDiv);
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
        dashboardData = data;

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

        // Summary stats
        const summaryDiv = $("#summary-section");
        if (summaryDiv) {
            loadAndRenderSummary(dashId, summaryDiv);
        }

        // Charts
        const chartsGrid = $("#charts-grid");
        chartsGrid.classList.remove("hidden");
        renderCharts(data.charts, "#charts-grid");

        // Populate "Add Chart" column selectors
        populateAddChartModal(data);

    } catch (err) {
        toast(err.message, "error");
    } finally {
        $("#loading").classList.add("hidden");
    }
}

/* ── Summary Stats ───────────────────────────────────────────── */
async function loadAndRenderSummary(dashId, container) {
    try {
        const res = await fetch(`/api/dashboards/${dashId}/summary`);
        if (!res.ok) return;
        const summaryData = await res.json();
        renderSummaryFromAPI(summaryData, container);
    } catch (err) {
        console.error("Failed to load summary:", err);
    }
}

function renderSummaryFromAPI(summaryData, container) {
    container.innerHTML = "";
    if (!summaryData || summaryData.length === 0) {
        container.classList.add("hidden");
        return;
    }
    container.classList.remove("hidden");

    summaryData.forEach((fileStats) => {
        if (!fileStats.stats || fileStats.stats.length === 0) return;
        container.innerHTML += buildSummaryTable(fileStats.filename, fileStats.stats);
    });
}

function renderSummaryStats(csvFiles, container) {
    container.innerHTML = "";
    let hasStats = false;

    csvFiles.forEach((cf) => {
        const stats = cf.summary_stats;
        if (!stats || stats.length === 0) return;
        hasStats = true;
        container.innerHTML += buildSummaryTable(cf.filename, stats);
    });

    if (hasStats) {
        container.classList.remove("hidden");
    } else {
        container.classList.add("hidden");
    }
}

function buildSummaryTable(filename, stats) {
    const fields = [
        { key: "count", label: "Count" },
        { key: "mean", label: "Mean" },
        { key: "median", label: "Median" },
        { key: "std", label: "Std Dev" },
        { key: "min", label: "Min" },
        { key: "q1", label: "Q1 (25%)" },
        { key: "q3", label: "Q3 (75%)" },
        { key: "max", label: "Max" },
        { key: "missing", label: "Missing" },
    ];

    return `
        <div class="bg-slate-900 rounded-xl border border-slate-800 overflow-hidden">
            <div class="px-4 py-3 border-b border-slate-800 flex items-center gap-2">
                <svg class="w-4 h-4 text-indigo-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 7h6m0 10v-3m-3 3h.01M9 17h.01M9 14h.01M12 14h.01M15 11h.01M12 11h.01M9 11h.01M7 21h10a2 2 0 002-2V5a2 2 0 00-2-2H7a2 2 0 00-2 2v14a2 2 0 002 2z"/></svg>
                <span class="text-sm font-medium text-slate-300">Summary Statistics</span>
                <span class="text-xs text-slate-600">${esc(filename)}</span>
            </div>
            <div class="overflow-x-auto">
                <table class="preview-table">
                    <thead>
                        <tr>
                            <th>Column</th>
                            ${fields.map((f) => `<th>${f.label}</th>`).join("")}
                        </tr>
                    </thead>
                    <tbody>
                        ${stats.map((s) => `
                            <tr>
                                <td class="font-medium text-indigo-300">${esc(s.column)}</td>
                                ${fields.map((f) => `<td>${formatNum(s[f.key])}</td>`).join("")}
                            </tr>
                        `).join("")}
                    </tbody>
                </table>
            </div>
        </div>`;
}

/* ── Render charts with type switcher ────────────────────────── */
function renderCharts(charts, gridSelector) {
    const grid = $(gridSelector);
    grid.innerHTML = "";

    chartInstances.forEach((ci) => ci.instance.destroy());
    chartInstances.length = 0;

    charts.forEach((chart, i) => {
        const cfg = chart.config || chart;
        const card = document.createElement("div");
        card.className = "chart-card";
        card.id = `chart-card-${i}`;

        // Chart type switcher dropdown
        const isPointChart = POINT_CHART_TYPES.includes(cfg.type);
        const availableTypes = isPointChart ? ["scatter"] : SWITCHABLE_TYPES;

        const header = document.createElement("div");
        header.className = "chart-header";
        header.innerHTML = `
            <span class="chart-title-text">${esc(chart.title || cfg.plugins?.title?.text || "Chart")}</span>
            <select class="chart-type-select" data-chart-index="${i}" onchange="switchChartType(${i}, this.value)">
                ${availableTypes.map((t) => `<option value="${t}" ${t === cfg.type ? "selected" : ""}>${capitalise(t)}</option>`).join("")}
            </select>
        `;
        card.appendChild(header);

        const canvasWrap = document.createElement("div");
        canvasWrap.className = "chart-canvas-wrap";
        const canvas = document.createElement("canvas");
        canvas.id = `chart-${i}`;
        canvasWrap.appendChild(canvas);
        card.appendChild(canvasWrap);
        grid.appendChild(card);

        const cfgCopy = JSON.parse(JSON.stringify(cfg));
        const instance = new Chart(canvas.getContext("2d"), cfgCopy);
        chartInstances.push({
            instance,
            originalConfig: JSON.parse(JSON.stringify(cfg)),
            canvasId: `chart-${i}`,
            cardId: `chart-card-${i}`,
        });
    });
}

/* ── Switch chart type ───────────────────────────────────────── */
function switchChartType(index, newType) {
    const ci = chartInstances[index];
    if (!ci) return;

    const origCfg = JSON.parse(JSON.stringify(ci.originalConfig));

    // Don't switch scatter ↔ label-based charts (incompatible data shapes)
    if (POINT_CHART_TYPES.includes(origCfg.type) && !POINT_CHART_TYPES.includes(newType)) return;

    origCfg.type = newType;

    // Adjust options for pie/doughnut/polarArea (no x/y scales)
    const noScaleTypes = ["pie", "doughnut", "polarArea"];
    if (noScaleTypes.includes(newType)) {
        delete origCfg.options?.scales;
        if (origCfg.options?.indexAxis) delete origCfg.options.indexAxis;
        if (origCfg.options?.plugins?.legend) {
            origCfg.options.plugins.legend.position = "right";
        }
    } else if (newType === "radar") {
        // Radar uses radial scales
        if (origCfg.options) {
            delete origCfg.options.scales;
            origCfg.options.scales = {
                r: { ticks: { color: "#94a3b8" }, grid: { color: "#334155" }, pointLabels: { color: "#cbd5e1" } },
            };
        }
    } else {
        // Restore x/y scales if missing
        if (!origCfg.options) origCfg.options = {};
        if (!origCfg.options.scales) {
            origCfg.options.scales = {
                x: { ticks: { color: "#94a3b8" }, grid: { color: "#334155" } },
                y: { ticks: { color: "#94a3b8" }, grid: { color: "#334155" } },
            };
        }
    }

    // For line charts, add tension
    if (newType === "line") {
        origCfg.data.datasets.forEach((ds) => {
            ds.tension = ds.tension || 0.35;
            ds.fill = ds.fill !== undefined ? ds.fill : false;
            ds.pointRadius = ds.pointRadius || 3;
        });
    }

    // Destroy old & create new
    ci.instance.destroy();
    const canvas = $(`#${ci.canvasId}`);
    const newInstance = new Chart(canvas.getContext("2d"), origCfg);
    ci.instance = newInstance;
}

/* ── Add Custom Chart Modal ──────────────────────────────────── */
function populateAddChartModal(data) {
    const colXSelect = $("#custom-col-x");
    const colYSelect = $("#custom-col-y");
    if (!colXSelect || !colYSelect) return;

    colXSelect.innerHTML = '<option value="">Select column...</option>';
    colYSelect.innerHTML = '<option value="">None (single column)</option>';

    const csvFile = data.csv_files?.[0];
    if (!csvFile) return;

    const meta = typeof csvFile.columns_meta === "string" ? JSON.parse(csvFile.columns_meta) : csvFile.columns_meta;
    if (!meta) return;

    Object.entries(meta).forEach(([col, info]) => {
        const typeLabel = info.dtype || "unknown";
        const opt = `<option value="${esc(col)}">${esc(col)} (${typeLabel})</option>`;
        colXSelect.innerHTML += opt;
        colYSelect.innerHTML += opt;
    });
}

function openAddChartModal() {
    const modal = $("#add-chart-modal");
    if (modal) modal.classList.remove("hidden");
    if (dashboardData) populateAddChartModal(dashboardData);
}

function closeAddChartModal() {
    const modal = $("#add-chart-modal");
    if (modal) modal.classList.add("hidden");
}

async function submitCustomChart() {
    const chartType = $("#custom-chart-type")?.value;
    const colX = $("#custom-col-x")?.value;
    const colY = $("#custom-col-y")?.value;
    const dashId = currentDashboardId || window.location.pathname.split("/").pop();

    if (!colX) {
        toast("Please select at least one column", "error");
        return;
    }

    if (chartType === "scatter" && !colY) {
        toast("Scatter plots require two columns", "error");
        return;
    }

    const csvFileId = dashboardData?.csv_files?.[0]?.id;

    const body = { chart_type: chartType, col_x: colX, csv_file_id: csvFileId };
    if (colY) body.col_y = colY;

    try {
        const res = await fetch(`/api/dashboards/${dashId}/charts`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
        });
        if (!res.ok) {
            const err = await res.json();
            throw new Error(err.detail || "Failed to create chart");
        }
        const chart = await res.json();

        // Add chart to the grid dynamically
        const grid = $("#charts-grid");
        const idx = chartInstances.length;
        const cfg = chart.config || chart;

        const card = document.createElement("div");
        card.className = "chart-card";
        card.id = `chart-card-${idx}`;

        const isPointChart = POINT_CHART_TYPES.includes(cfg.type);
        const availableTypes = isPointChart ? ["scatter"] : SWITCHABLE_TYPES;

        const header = document.createElement("div");
        header.className = "chart-header";
        header.innerHTML = `
            <span class="chart-title-text">${esc(chart.title || "Custom Chart")}</span>
            <select class="chart-type-select" data-chart-index="${idx}" onchange="switchChartType(${idx}, this.value)">
                ${availableTypes.map((t) => `<option value="${t}" ${t === cfg.type ? "selected" : ""}>${capitalise(t)}</option>`).join("")}
            </select>
        `;
        card.appendChild(header);

        const canvasWrap = document.createElement("div");
        canvasWrap.className = "chart-canvas-wrap";
        const canvas = document.createElement("canvas");
        canvas.id = `chart-${idx}`;
        canvasWrap.appendChild(canvas);
        card.appendChild(canvasWrap);

        grid.appendChild(card);

        // Animate in
        card.style.opacity = "0";
        card.style.transform = "translateY(20px)";
        requestAnimationFrame(() => {
            card.style.transition = "all 0.3s ease";
            card.style.opacity = "1";
            card.style.transform = "translateY(0)";
        });

        const cfgCopy = JSON.parse(JSON.stringify(cfg));
        const instance = new Chart(canvas.getContext("2d"), cfgCopy);
        chartInstances.push({
            instance,
            originalConfig: JSON.parse(JSON.stringify(cfg)),
            canvasId: `chart-${idx}`,
            cardId: `chart-card-${idx}`,
        });

        closeAddChartModal();
        toast("Chart added!", "success");
        card.scrollIntoView({ behavior: "smooth", block: "center" });
    } catch (err) {
        toast(err.message, "error");
    }
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

function formatNum(val) {
    if (val === undefined || val === null) return "—";
    if (typeof val === "number") return val.toLocaleString(undefined, { maximumFractionDigits: 2 });
    return String(val);
}

function capitalise(str) {
    return str.charAt(0).toUpperCase() + str.slice(1);
}
