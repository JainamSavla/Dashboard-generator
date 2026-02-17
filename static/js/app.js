/*  State  */
let selectedFiles = [];
let currentDashboardId = null;
const chartInstances = [];      // {instance, originalConfig, canvasId, cardId, chartId, csvFileId}
let dashboardData = null;       // full dashboard data for custom chart building

/*  DOM refs  */
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

/* compatible chart types for switching */
const SWITCHABLE_TYPES = ["bar", "line", "pie", "doughnut", "polarArea", "radar"];
const POINT_CHART_TYPES = ["scatter", "bubble"];

/*  Init (runs on index.html only)  */
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

/*  File management  */
function addFiles(files) {
    const MAX_FILE_SIZE_MB = 100;
    const MAX_FILE_SIZE_BYTES = MAX_FILE_SIZE_MB * 1024 * 1024;
    
    files.forEach((f) => {
        // Check file size
        if (f.size > MAX_FILE_SIZE_BYTES) {
            const sizeMB = (f.size / (1024 * 1024)).toFixed(1);
            toast(`File '${f.name}' is too large (${sizeMB}MB). Maximum allowed: ${MAX_FILE_SIZE_MB}MB`, "error");
            return;
        }
        
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

    // Show/hide role assignment when multiple files
    const roleDiv = $("#role-assignment");
    if (roleDiv) {
        if (selectedFiles.length > 1) {
            roleDiv.classList.remove("hidden");
            renderRoleAssignment();
        } else {
            roleDiv.classList.add("hidden");
        }
    }
}

/*  Upload handler  */
async function handleUpload() {
    if (selectedFiles.length === 0) return;

    const formData = new FormData();
    selectedFiles.forEach((f) => formData.append("files", f));

    const name = $("#dashboard-name").value.trim();
    if (name) formData.append("dashboard_name", name);

    // Collect roles
    const roles = selectedFiles.map((f, i) => {
        const roleSelect = $(`#file-role-${i}`);
        return { role: roleSelect ? roleSelect.value : (i === 0 ? "primary" : "secondary") };
    });
    formData.append("roles", JSON.stringify(roles));

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

/*  Show dashboard preview (index.html)  */
function showPreview(data) {
    $("#upload-section").classList.remove("hidden");
    $("#preview-section").classList.remove("hidden");
    $("#preview-title").textContent = data.name;

    // Data preview tables � ALL CSVs
    const previewDiv = $("#data-preview");
    previewDiv.innerHTML = "";

    (data.csv_files || []).forEach((cf) => {
        if (!cf.preview || cf.preview.length === 0) return;
        const rows = cf.preview;
        const cols = Object.keys(rows[0] || {});
        previewDiv.innerHTML += `
            <div class="bg-slate-900 rounded-xl border border-slate-800 overflow-hidden mb-4">
                <div class="px-4 py-2 border-b border-slate-800 flex items-center gap-2">
                    <span class="text-sm font-medium text-slate-300">Data Preview</span>
                    <span class="text-xs text-slate-600">${esc(cf.filename)}  ${cf.rows.toLocaleString()} rows  ${cf.cols} columns</span>
                </div>
                <div class="overflow-x-auto max-h-48">
                    <table class="preview-table">
                        <thead><tr>${cols.map((c) => "<th>" + esc(c) + "</th>").join("")}</tr></thead>
                        <tbody>${rows.map((r) => "<tr>" + cols.map((c) => "<td>" + esc(String(r[c] ?? "")) + "</td>").join("") + "</tr>").join("")}</tbody>
                    </table>
                </div>
            </div>`;
    });

    // Summary stats � ALL CSVs
    const summaryDiv = $("#summary-section");
    if (summaryDiv && data.csv_files) {
        renderSummaryStats(data.csv_files, summaryDiv);
    }

    renderCharts(data.charts, "#charts-grid");
}

/*  Load single dashboard (dashboard.html)  */
async function loadSingleDashboard(dashId) {
    currentDashboardId = dashId;
    try {
        const res = await fetch("/api/dashboards/" + dashId);
        if (!res.ok) throw new Error("Dashboard not found");
        const data = await res.json();
        dashboardData = data;

        $("#dash-title").textContent = data.name;
        $("#dash-meta").textContent = "Created " + formatDate(data.created_at) + "  " + data.charts.length + " charts  " + (data.csv_files || []).length + " files";

        // CSV info cards with download buttons
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
                    <div class="text-sm text-indigo-400 font-medium mb-2 truncate">${esc(cf.original_filename)}</div>
                    <div class="flex justify-around">
                        <div><div class="value">${cf.row_count?.toLocaleString() || "?"}</div><div class="label">Rows</div></div>
                        <div><div class="value">${cf.col_count || "?"}</div><div class="label">Columns</div></div>
                    </div>
                    <div class="text-xs text-slate-500 mt-2">
                        ${numericCount} numeric  ${catCount} categorical  ${dateCount} datetime
                    </div>
                    <button onclick="downloadCSV('${esc(cf.id)}')" class="mt-2 text-xs text-emerald-400 hover:text-emerald-300 transition flex items-center gap-1 mx-auto">
                        <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 10v6m0 0l-3-3m3 3l3-3m2 8H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"/></svg>
                        Download CSV
                    </button>
                </div>`;
        });
        infoDiv.classList.remove("hidden");

        // Summary stats � ALL CSVs
        const summaryDiv = $("#summary-section");
        if (summaryDiv) {
            loadAndRenderSummary(dashId, summaryDiv);
        }

        // Charts
        const chartsGrid = $("#charts-grid");
        chartsGrid.classList.remove("hidden");
        renderCharts(data.charts, "#charts-grid");

        // Populate "Add Chart" column selectors � ALL CSVs
        populateAddChartModal(data);

    } catch (err) {
        toast(err.message, "error");
    } finally {
        $("#loading").classList.add("hidden");
    }
}

/*  Download individual CSV  */
function downloadCSV(csvFileId) {
    const dashId = currentDashboardId || window.location.pathname.split("/").pop();
    const a = document.createElement("a");
    a.href = "/api/dashboards/" + dashId + "/csv/" + csvFileId + "/download";
    a.download = "";
    document.body.appendChild(a);
    a.click();
    a.remove();
    toast("Downloading CSV", "success");
}

/*  Summary Stats  */
async function loadAndRenderSummary(dashId, container) {
    try {
        const res = await fetch("/api/dashboards/" + dashId + "/summary");
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

    return '<div class="bg-slate-900 rounded-xl border border-slate-800 overflow-hidden mb-4">'
        + '<div class="px-4 py-3 border-b border-slate-800 flex items-center gap-2">'
        + '<svg class="w-4 h-4 text-indigo-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 7h6m0 10v-3m-3 3h.01M9 17h.01M9 14h.01M12 14h.01M15 11h.01M12 11h.01M9 11h.01M7 21h10a2 2 0 002-2V5a2 2 0 00-2-2H7a2 2 0 00-2 2v14a2 2 0 002 2z"/></svg>'
        + '<span class="text-sm font-medium text-slate-300">Summary Statistics</span>'
        + '<span class="text-xs text-slate-600">' + esc(filename) + '</span>'
        + '</div>'
        + '<div class="overflow-x-auto">'
        + '<table class="preview-table">'
        + '<thead><tr><th>Column</th>'
        + fields.map((f) => "<th>" + f.label + "</th>").join("")
        + '</tr></thead>'
        + '<tbody>'
        + stats.map((s) =>
            '<tr><td class="font-medium text-indigo-300">' + esc(s.column) + '</td>'
            + fields.map((f) => "<td>" + formatNum(s[f.key]) + "</td>").join("")
            + '</tr>'
        ).join("")
        + '</tbody></table></div></div>';
}

/*  Render charts with type switcher, delete, rename  */
function renderCharts(charts, gridSelector) {
    const grid = $(gridSelector);
    grid.innerHTML = "";

    chartInstances.forEach((ci) => ci.instance.destroy());
    chartInstances.length = 0;

    // Map csv_file_id to filename for grouping headers
    const csvFileMap = {};
    if (dashboardData && dashboardData.csv_files) {
        dashboardData.csv_files.forEach((cf) => {
            csvFileMap[cf.id || cf.csv_file_id] = cf.original_filename || cf.filename;
        });
    }

    let lastCsvFileId = null;

    charts.forEach((chart, i) => {
        const cfg = chart.config || chart;
        const chartId = chart.id || null;
        const csvFileId = chart.csv_file_id || null;

        // Insert a file separator when CSV source changes
        if (csvFileId && csvFileId !== lastCsvFileId && csvFileMap[csvFileId]) {
            const separator = document.createElement("div");
            separator.className = "col-span-1 lg:col-span-2 mt-4 mb-1";
            separator.innerHTML =
                '<div class="flex items-center gap-2">'
                + '<svg class="w-4 h-4 text-indigo-400 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"/></svg>'
                + '<span class="text-sm font-semibold text-indigo-400">' + esc(csvFileMap[csvFileId]) + '</span>'
                + '<div class="flex-1 border-t border-slate-800"></div>'
                + '</div>';
            grid.appendChild(separator);
            lastCsvFileId = csvFileId;
        }

        const card = document.createElement("div");
        card.className = "chart-card";
        card.id = "chart-card-" + i;

        const isPointChart = POINT_CHART_TYPES.includes(cfg.type);
        const availableTypes = isPointChart ? ["scatter"] : SWITCHABLE_TYPES;

        const header = document.createElement("div");
        header.className = "chart-header";
        header.innerHTML =
            '<span class="chart-title-text" id="chart-title-' + i + '" ondblclick="startRenameChart(' + i + ')" title="Double-click to rename">' + esc(chart.title || (cfg.options && cfg.options.plugins && cfg.options.plugins.title && cfg.options.plugins.title.text) || "Chart") + '</span>'
            + '<div class="chart-actions">'
            + '<button class="chart-action-btn" onclick="startRenameChart(' + i + ')" title="Rename"><svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z"/></svg></button>'
            + '<button class="chart-action-btn chart-action-delete" onclick="deleteChart(' + i + ')" title="Delete"><svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"/></svg></button>'
            + '<select class="chart-type-select" data-chart-index="' + i + '" onchange="switchChartType(' + i + ', this.value)">'
            + availableTypes.map((t) => '<option value="' + t + '"' + (t === cfg.type ? ' selected' : '') + '>' + capitalise(t) + '</option>').join("")
            + '</select></div>';
        card.appendChild(header);

        const canvasWrap = document.createElement("div");
        canvasWrap.className = "chart-canvas-wrap";
        const canvas = document.createElement("canvas");
        canvas.id = "chart-" + i;
        canvasWrap.appendChild(canvas);
        card.appendChild(canvasWrap);

        grid.appendChild(card);

        const cfgCopy = JSON.parse(JSON.stringify(cfg));
        const instance = new Chart(canvas.getContext("2d"), cfgCopy);
        chartInstances.push({
            instance: instance,
            originalConfig: JSON.parse(JSON.stringify(cfg)),
            canvasId: "chart-" + i,
            cardId: "chart-card-" + i,
            chartId: chartId,
            csvFileId: csvFileId,
        });
    });
}

/*  Delete chart  */
async function deleteChart(index) {
    const ci = chartInstances[index];
    if (!ci) return;

    if (!confirm("Delete this chart?")) return;

    const dashId = currentDashboardId || window.location.pathname.split("/").pop();

    if (ci.chartId) {
        try {
            const res = await fetch("/api/dashboards/" + dashId + "/charts/" + ci.chartId, { method: "DELETE" });
            if (!res.ok) {
                const err = await res.json();
                throw new Error(err.detail || "Delete failed");
            }
        } catch (err) {
            toast(err.message, "error");
            return;
        }
    }

    ci.instance.destroy();
    const card = $("#" + ci.cardId);
    if (card) {
        card.style.transition = "all 0.3s ease";
        card.style.opacity = "0";
        card.style.transform = "scale(0.9)";
        setTimeout(function() { card.remove(); }, 300);
    }

    chartInstances[index] = null;
    toast("Chart deleted", "success");
}

/*  Rename chart  */
function startRenameChart(index) {
    const ci = chartInstances[index];
    if (!ci) return;

    const titleSpan = $("#chart-title-" + index);
    if (!titleSpan) return;

    const currentTitle = titleSpan.textContent;
    const input = document.createElement("input");
    input.type = "text";
    input.value = currentTitle;
    input.className = "chart-rename-input";
    input.style.cssText = "background:#0f172a;border:1px solid #6366f1;border-radius:4px;color:#e2e8f0;font-size:0.8rem;font-weight:600;padding:2px 6px;width:100%;outline:none;";

    titleSpan.replaceWith(input);
    input.focus();
    input.select();

    var finished = false;
    var finishRename = async function() {
        if (finished) return;
        finished = true;
        var newTitle = input.value.trim() || currentTitle;
        var newSpan = document.createElement("span");
        newSpan.className = "chart-title-text";
        newSpan.id = "chart-title-" + index;
        newSpan.setAttribute("ondblclick", "startRenameChart(" + index + ")");
        newSpan.setAttribute("title", "Double-click to rename");
        newSpan.textContent = newTitle;
        input.replaceWith(newSpan);

        if (newTitle !== currentTitle) {
            var dashId = currentDashboardId || window.location.pathname.split("/").pop();
            if (ci.chartId) {
                try {
                    var res = await fetch("/api/dashboards/" + dashId + "/charts/" + ci.chartId, {
                        method: "PATCH",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({ title: newTitle }),
                    });
                    if (res.ok) {
                        if (ci.instance.options && ci.instance.options.plugins && ci.instance.options.plugins.title) {
                            ci.instance.options.plugins.title.text = newTitle;
                            ci.instance.update();
                        }
                        toast("Chart renamed", "success");
                    }
                } catch (err) {
                    toast("Rename failed", "error");
                }
            }
        }
    };

    input.addEventListener("blur", finishRename);
    input.addEventListener("keydown", function(e) {
        if (e.key === "Enter") { e.preventDefault(); input.blur(); }
        if (e.key === "Escape") { input.value = currentTitle; input.blur(); }
    });
}

/*  Switch chart type  */
function switchChartType(index, newType) {
    const ci = chartInstances[index];
    if (!ci) return;

    const origCfg = JSON.parse(JSON.stringify(ci.originalConfig));

    if (POINT_CHART_TYPES.includes(origCfg.type) && !POINT_CHART_TYPES.includes(newType)) return;

    origCfg.type = newType;

    const noScaleTypes = ["pie", "doughnut", "polarArea"];
    if (noScaleTypes.includes(newType)) {
        if (origCfg.options && origCfg.options.scales) delete origCfg.options.scales;
        if (origCfg.options && origCfg.options.indexAxis) delete origCfg.options.indexAxis;
        if (origCfg.options && origCfg.options.plugins && origCfg.options.plugins.legend) {
            origCfg.options.plugins.legend.position = "right";
        }
    } else if (newType === "radar") {
        if (origCfg.options) {
            delete origCfg.options.scales;
            origCfg.options.scales = {
                r: { ticks: { color: "#94a3b8" }, grid: { color: "#334155" }, pointLabels: { color: "#cbd5e1" } },
            };
        }
    } else {
        if (!origCfg.options) origCfg.options = {};
        if (!origCfg.options.scales) {
            origCfg.options.scales = {
                x: { ticks: { color: "#94a3b8" }, grid: { color: "#334155" } },
                y: { ticks: { color: "#94a3b8" }, grid: { color: "#334155" } },
            };
        }
    }

    if (newType === "line") {
        origCfg.data.datasets.forEach(function(ds) {
            ds.tension = ds.tension || 0.35;
            ds.fill = ds.fill !== undefined ? ds.fill : false;
            ds.pointRadius = ds.pointRadius || 3;
        });
    }

    ci.instance.destroy();
    var canvas = $("#" + ci.canvasId);
    var newInstance = new Chart(canvas.getContext("2d"), origCfg);
    ci.instance = newInstance;
}

/*  Add Custom Chart Modal – supports cross-CSV charts  */
function populateAddChartModal(data) {
    var csvXSelect = $("#custom-csv-x");
    var csvYSelect = $("#custom-csv-y");
    if (!csvXSelect) return;

    var opts = "";
    (data.csv_files || []).forEach(function(cf, i) {
        var fname = cf.original_filename || cf.filename;
        var id = cf.id || cf.csv_file_id || "";
        opts += '<option value="' + esc(id) + '"' + (i === 0 ? ' selected' : '') + '>' + esc(fname) + '</option>';
    });
    csvXSelect.innerHTML = opts;

    if (csvYSelect) {
        csvYSelect.innerHTML = '<option value="">Same as X-axis</option>' + opts;
    }

    // Populate initial columns
    populateColumnsForAxis("x");
    populateColumnsForAxis("y");
}

function populateColumnsForAxis(axis) {
    // axis = "x" or "y"
    var csvSelect = $("#custom-csv-" + axis);
    var colSelect = $("#custom-col-" + axis);
    if (!colSelect) return;

    var csvFileId = csvSelect ? csvSelect.value : "";

    // For Y-axis, if "Same as X-axis" is selected, use X's CSV
    if (axis === "y" && !csvFileId) {
        var csvXSelect = $("#custom-csv-x");
        csvFileId = csvXSelect ? csvXSelect.value : "";
    }

    var defaultLabel = axis === "x" ? "Select column..." : "None (single column)";
    colSelect.innerHTML = '<option value="">' + defaultLabel + '</option>';

    if (!csvFileId || !dashboardData) return;

    var csvFile = null;
    (dashboardData.csv_files || []).forEach(function(cf) {
        if ((cf.id || cf.csv_file_id) === csvFileId) csvFile = cf;
    });
    if (!csvFile) return;

    var meta = typeof csvFile.columns_meta === "string" ? JSON.parse(csvFile.columns_meta) : csvFile.columns_meta;
    if (!meta) return;

    Object.entries(meta).forEach(function(entry) {
        var col = entry[0];
        var info = entry[1];
        var typeLabel = info.dtype || "unknown";
        colSelect.innerHTML += '<option value="' + esc(col) + '">' + esc(col) + ' (' + typeLabel + ')</option>';
    });
}

function openAddChartModal() {
    var modal = $("#add-chart-modal");
    if (modal) modal.classList.remove("hidden");
    if (dashboardData) populateAddChartModal(dashboardData);
}

function closeAddChartModal() {
    var modal = $("#add-chart-modal");
    if (modal) modal.classList.add("hidden");
}

async function submitCustomChart() {
    var chartType = $("#custom-chart-type") ? $("#custom-chart-type").value : "";
    var colX = $("#custom-col-x") ? $("#custom-col-x").value : "";
    var colY = $("#custom-col-y") ? $("#custom-col-y").value : "";
    var csvXSelect = $("#custom-csv-x");
    var csvYSelect = $("#custom-csv-y");
    var dashId = currentDashboardId || window.location.pathname.split("/").pop();

    if (!colX) {
        toast("Please select at least one column", "error");
        return;
    }

    if (chartType === "scatter" && !colY) {
        toast("Scatter plots require two columns", "error");
        return;
    }

    var csvFileIdX = csvXSelect ? csvXSelect.value : "";
    var csvFileIdY = csvYSelect ? csvYSelect.value : "";

    // Determine if cross-CSV (Y from different CSV than X)
    var isCrossCSV = colY && csvFileIdY && csvFileIdY !== csvFileIdX;

    var url, body;
    if (isCrossCSV) {
        url = "/api/dashboards/" + dashId + "/charts/cross";
        body = {
            chart_type: chartType,
            csv_file_id_x: csvFileIdX,
            col_x: colX,
            csv_file_id_y: csvFileIdY,
            col_y: colY,
        };
    } else {
        url = "/api/dashboards/" + dashId + "/charts";
        body = { chart_type: chartType, col_x: colX, csv_file_id: csvFileIdX };
        if (colY) body.col_y = colY;
    }

    try {
        var res = await fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
        });
        if (!res.ok) {
            var errBody = await res.json();
            throw new Error(errBody.detail || "Failed to create chart");
        }
        var chart = await res.json();

        var grid = $("#charts-grid");
        var idx = chartInstances.length;
        var cfg = chart.config || chart;

        var card = document.createElement("div");
        card.className = "chart-card";
        card.id = "chart-card-" + idx;

        var isPointChart = POINT_CHART_TYPES.includes(cfg.type);
        var availableTypes = isPointChart ? ["scatter"] : SWITCHABLE_TYPES;

        var header = document.createElement("div");
        header.className = "chart-header";
        header.innerHTML =
            '<span class="chart-title-text" id="chart-title-' + idx + '" ondblclick="startRenameChart(' + idx + ')" title="Double-click to rename">' + esc(chart.title || "Custom Chart") + '</span>'
            + '<div class="chart-actions">'
            + '<button class="chart-action-btn" onclick="startRenameChart(' + idx + ')" title="Rename"><svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z"/></svg></button>'
            + '<button class="chart-action-btn chart-action-delete" onclick="deleteChart(' + idx + ')" title="Delete"><svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"/></svg></button>'
            + '<select class="chart-type-select" data-chart-index="' + idx + '" onchange="switchChartType(' + idx + ', this.value)">'
            + availableTypes.map(function(t) { return '<option value="' + t + '"' + (t === cfg.type ? ' selected' : '') + '>' + capitalise(t) + '</option>'; }).join("")
            + '</select></div>';
        card.appendChild(header);

        var canvasWrap = document.createElement("div");
        canvasWrap.className = "chart-canvas-wrap";
        var canvas = document.createElement("canvas");
        canvas.id = "chart-" + idx;
        canvasWrap.appendChild(canvas);
        card.appendChild(canvasWrap);

        grid.appendChild(card);

        card.style.opacity = "0";
        card.style.transform = "translateY(20px)";
        requestAnimationFrame(function() {
            card.style.transition = "all 0.3s ease";
            card.style.opacity = "1";
            card.style.transform = "translateY(0)";
        });

        var cfgCopy = JSON.parse(JSON.stringify(cfg));
        var instance = new Chart(canvas.getContext("2d"), cfgCopy);
        chartInstances.push({
            instance: instance,
            originalConfig: JSON.parse(JSON.stringify(cfg)),
            canvasId: "chart-" + idx,
            cardId: "chart-card-" + idx,
            chartId: chart.id || null,
            csvFileId: csvFileIdX,
        });

        closeAddChartModal();
        toast("Chart added!", "success");
        card.scrollIntoView({ behavior: "smooth", block: "center" });
    } catch (err) {
        toast(err.message, "error");
    }
}

/*  Load dashboards list  */
async function loadDashboards() {
    var listDiv = $("#dashboards-list");
    var emptyMsg = $("#no-dashboards");
    if (!listDiv) return;

    try {
        var res = await fetch("/api/dashboards");
        var dashboards = await res.json();

        if (dashboards.length === 0) {
            listDiv.innerHTML = "";
            if (emptyMsg) emptyMsg.classList.remove("hidden");
            return;
        }

        if (emptyMsg) emptyMsg.classList.add("hidden");
        listDiv.innerHTML = dashboards
            .map(function(d) {
                return '<div class="dash-card" onclick="window.location=\'/dashboard/' + d.id + '\'">'
                    + '<div class="flex items-start justify-between mb-3">'
                    + '<h3 class="font-semibold text-white text-sm truncate flex-1">' + esc(d.name) + '</h3>'
                    + '<span class="text-xs text-slate-600 ml-2 shrink-0">' + formatDate(d.created_at) + '</span>'
                    + '</div>'
                    + '<div class="flex items-center gap-3 text-xs text-slate-500">'
                    + '<span class="flex items-center gap-1">'
                    + '<svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2z"/></svg>'
                    + d.chart_count + ' charts</span>'
                    + '<span class="flex items-center gap-1">'
                    + '<svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"/></svg>'
                    + esc(d.csv_files || "�") + '</span>'
                    + '</div></div>';
            })
            .join("");
    } catch (err) {
        console.error("Failed to load dashboards:", err);
    }
}

/*  Export  */
function exportDashboard(format) {
    if (!currentDashboardId) return;
    _doExport(currentDashboardId, format);
}

function exportCurrent(format) {
    var dashId = window.location.pathname.split("/").pop();
    _doExport(dashId, format);
}

function _doExport(dashId, format) {
    if (format === "pdf") {
        toast("Preparing PDF � uses browser print", "success");
        window.print();
        return;
    }
    var url = "/api/dashboards/" + dashId + "/export/" + format;
    var a = document.createElement("a");
    a.href = url;
    a.download = "";
    document.body.appendChild(a);
    a.click();
    a.remove();
    toast("Downloading " + format.toUpperCase() + "...", "success");
}

/*  Delete dashboard  */
async function deleteCurrent() {
    var dashId = window.location.pathname.split("/").pop();
    if (!confirm("Delete this dashboard permanently?")) return;

    try {
        var res = await fetch("/api/dashboards/" + dashId, { method: "DELETE" });
        if (!res.ok) throw new Error("Delete failed");
        toast("Dashboard deleted", "success");
        setTimeout(function() { window.location.href = "/"; }, 800);
    } catch (err) {
        toast(err.message, "error");
    }
}

/*  Utilities  */
function toast(msg, type) {
    type = type || "success";
    var el = document.createElement("div");
    el.className = "toast " + type;
    el.textContent = msg;
    document.body.appendChild(el);
    setTimeout(function() { el.remove(); }, 3200);
}

function esc(str) {
    var d = document.createElement("div");
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
    var d = new Date(dateStr);
    return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

function formatNum(val) {
    if (val === undefined || val === null) return "�";
    if (typeof val === "number") return val.toLocaleString(undefined, { maximumFractionDigits: 2 });
    return String(val);
}

function capitalise(str) {
    return str.charAt(0).toUpperCase() + str.slice(1);
}

/*  Role assignment for multi-CSV upload  */
function renderRoleAssignment() {
    var container = $("#role-list");
    if (!container) return;
    container.innerHTML = "";

    selectedFiles.forEach(function(f, i) {
        container.innerHTML +=
            '<div class="flex items-center gap-3">'
            + '<span class="text-sm text-slate-300 flex-1 truncate">' + esc(f.name) + '</span>'
            + '<select id="file-role-' + i + '" class="modal-select" style="max-width:200px">'
            + '<option value="primary"' + (i === 0 ? ' selected' : '') + '>Primary</option>'
            + '<option value="secondary"' + (i > 0 ? ' selected' : '') + '>Secondary</option>'
            + '<option value="sales_data">Sales Data</option>'
            + '<option value="order_details">Order Details</option>'
            + '<option value="customer_data">Customer Data</option>'
            + '<option value="product_data">Product Data</option>'
            + '<option value="other">Other</option>'
            + '</select></div>';
    });
}

/*  Navigate to merge page  */
function goToMerge() {
    var dashId = currentDashboardId || window.location.pathname.split("/").pop();
    window.location.href = "/dashboard/" + dashId + "/merge";
}
