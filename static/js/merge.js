/* ── merge.js ─────────────────────────────────────────────────
   Handles the Clean ▸ Map ▸ Merge workflow on merge.html
   ──────────────────────────────────────────────────────────── */

let mergeDashId = null;
let mergeColumnsData = null;   // {files, common_columns}
let currentMergeId = null;
let columnMappings = [];       // one dict per csv

/* helper from app.js */
const _$ = (sel) => document.querySelector(sel);
const _esc = (str) => { const d = document.createElement("div"); d.textContent = str; return d.innerHTML; };

/* ── Init ─────────────────────────────────────────────────────── */
async function initMergePage(dashId) {
    mergeDashId = dashId;
    try {
        const res = await fetch(`/api/dashboards/${dashId}/columns`);
        if (!res.ok) throw new Error("Failed to load CSV info");
        mergeColumnsData = await res.json();

        if (mergeColumnsData.files.length < 2) {
            _$("#loading").innerHTML = `
                <div class="text-center py-20">
                    <p class="text-slate-400 text-lg mb-4">You need at least 2 CSVs to merge.</p>
                    <a href="/dashboard/${dashId}" class="add-chart-btn" style="text-decoration:none">← Back to Dashboard</a>
                </div>`;
            return;
        }

        _$("#merge-subtitle").textContent =
            `${mergeColumnsData.files.length} CSV files · ${mergeColumnsData.common_columns.length} common columns`;

        _$("#loading").classList.add("hidden");
        _$("#step-clean").classList.remove("hidden");
        _$("#step-mapping").classList.remove("hidden");
        _$("#step-merge").classList.remove("hidden");

        renderMappingUI();
        renderMergeKeysUI();
    } catch (err) {
        _$("#loading").innerHTML = `<p class="text-red-400 text-center py-20">${_esc(err.message)}</p>`;
    }
}


/* ── Step 1: Clean ─────────────────────────────────────────────── */
async function cleanAllCSVs() {
    const opts = {
        numeric_strategy: _$("#clean-numeric").value,
        outlier_method: _$("#clean-outlier").value || null,
        normalize: _$("#clean-normalize").value || null,
    };

    const btn = _$("#step-clean .add-chart-btn");
    btn.disabled = true;
    btn.textContent = "Cleaning…";

    try {
        const res = await fetch(`/api/dashboards/${mergeDashId}/clean-all`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(opts),
        });
        if (!res.ok) throw new Error("Cleaning failed");
        const data = await res.json();

        const container = _$("#clean-results");
        container.innerHTML = "";
        container.classList.remove("hidden");

        data.results.forEach((r) => {
            if (r.error) {
                container.innerHTML += `
                    <div class="bg-red-900/30 border border-red-800 rounded-xl p-4">
                        <div class="text-sm font-medium text-red-400 mb-1">${_esc(r.filename)}</div>
                        <p class="text-xs text-red-300">${_esc(r.error)}</p>
                    </div>`;
                return;
            }

            const logHtml = r.cleaning_log.map((l) => `
                <div class="flex items-start gap-2 text-xs">
                    <span class="shrink-0 px-1.5 py-0.5 rounded text-xs font-mono
                        ${l.action === 'summary' ? 'bg-emerald-900/50 text-emerald-400' : 'bg-slate-800 text-slate-400'}">
                        ${_esc(l.action)}
                    </span>
                    <span class="text-slate-300">${_esc(l.detail)}</span>
                </div>
            `).join("");

            container.innerHTML += `
                <div class="bg-slate-900 border border-slate-800 rounded-xl p-4">
                    <div class="flex items-center gap-2 mb-3">
                        <svg class="w-4 h-4 text-emerald-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7"/></svg>
                        <span class="text-sm font-medium text-white">${_esc(r.filename)}</span>
                        <span class="text-xs text-slate-500">${r.rows} rows × ${r.cols} cols</span>
                    </div>
                    <div class="space-y-1.5">${logHtml}</div>
                </div>`;
        });

        // Refresh column data after cleaning
        const res2 = await fetch(`/api/dashboards/${mergeDashId}/columns`);
        if (res2.ok) {
            mergeColumnsData = await res2.json();
            renderMappingUI();
            renderMergeKeysUI();
        }

        toast("All CSVs cleaned!", "success");
    } catch (err) {
        toast(err.message, "error");
    } finally {
        btn.disabled = false;
        btn.innerHTML = `<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7"/></svg> Clean All CSVs`;
    }
}


/* ── Step 2: Column Mapping ────────────────────────────────────── */
function renderMappingUI() {
    const area = _$("#mapping-area");
    area.innerHTML = "";
    columnMappings = mergeColumnsData.files.map(() => ({}));

    mergeColumnsData.files.forEach((file, fIdx) => {
        const cols = file.columns.map((c) => c.name);
        const colChips = cols.map((c) =>
            `<span class="inline-flex items-center gap-1 bg-slate-800 rounded-full px-2.5 py-1 text-xs text-slate-300">
                ${_esc(c)}
                <span class="text-slate-600">(${file.columns.find(x => x.name === c)?.dtype || '?'})</span>
            </span>`
        ).join(" ");

        area.innerHTML += `
            <div class="bg-slate-900 border border-slate-800 rounded-xl p-4">
                <div class="flex items-center gap-2 mb-3">
                    <span class="text-sm font-medium text-indigo-400">CSV #${fIdx + 1}:</span>
                    <span class="text-sm text-white">${_esc(file.filename)}</span>
                    <span class="text-xs text-slate-500">(${file.columns.length} columns)</span>
                </div>
                <div class="flex flex-wrap gap-1.5 mb-3">${colChips}</div>
                <div id="mapping-rows-${fIdx}" class="space-y-2"></div>
                <button onclick="addMappingRow(${fIdx})" class="text-xs text-indigo-400 hover:text-indigo-300 mt-2 transition">
                    + Add column rename
                </button>
            </div>`;
    });
}

function addMappingRow(fIdx) {
    const container = _$(`#mapping-rows-${fIdx}`);
    const file = mergeColumnsData.files[fIdx];
    const rowId = `map-${fIdx}-${container.children.length}`;

    const row = document.createElement("div");
    row.className = "flex items-center gap-2";
    row.id = rowId;
    row.innerHTML = `
        <select class="modal-select flex-1 text-xs" data-fidx="${fIdx}" data-role="from" onchange="updateMapping(${fIdx})">
            <option value="">Rename from…</option>
            ${file.columns.map((c) => `<option value="${_esc(c.name)}">${_esc(c.name)}</option>`).join("")}
        </select>
        <span class="text-slate-600">→</span>
        <input type="text" class="modal-select flex-1 text-xs" placeholder="New name" data-fidx="${fIdx}" data-role="to" onchange="updateMapping(${fIdx})">
        <button onclick="this.parentElement.remove(); updateMapping(${fIdx})" class="text-slate-500 hover:text-red-400 transition">
            <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"/></svg>
        </button>
    `;
    container.appendChild(row);
}

function updateMapping(fIdx) {
    const container = _$(`#mapping-rows-${fIdx}`);
    const mapping = {};
    container.querySelectorAll("div").forEach((row) => {
        const from = row.querySelector("[data-role='from']")?.value;
        const to = row.querySelector("[data-role='to']")?.value?.trim();
        if (from && to) mapping[from] = to;
    });
    columnMappings[fIdx] = mapping;
}


/* ── Step 3: Merge Keys ────────────────────────────────────────── */
function renderMergeKeysUI() {
    const container = _$("#merge-keys-list");
    container.innerHTML = "";

    // Compute effective columns (after mappings) and find common ones
    const effectiveCols = mergeColumnsData.files.map((file, i) => {
        const cols = file.columns.map((c) => c.name);
        const mapping = columnMappings[i] || {};
        return cols.map((c) => mapping[c] || c);
    });

    let common = new Set(effectiveCols[0]);
    for (let i = 1; i < effectiveCols.length; i++) {
        common = new Set([...common].filter((c) => effectiveCols[i].includes(c)));
    }

    const commonArr = [...common].sort();

    if (commonArr.length === 0) {
        container.innerHTML = `<p class="text-xs text-yellow-400">No common columns found. Use column mapping above to align column names.</p>`;
        return;
    }

    commonArr.forEach((col) => {
        container.innerHTML += `
            <label class="flex items-center gap-2 cursor-pointer">
                <input type="checkbox" value="${_esc(col)}" class="merge-key-checkbox accent-indigo-500">
                <span class="text-sm text-slate-300">${_esc(col)}</span>
            </label>`;
    });
}

function getSelectedMergeKeys() {
    return [...document.querySelectorAll(".merge-key-checkbox:checked")].map((cb) => cb.value);
}

function getColumnMappings() {
    // Recalculate in case user changed
    mergeColumnsData.files.forEach((_, i) => updateMapping(i));
    return columnMappings;
}


/* ── Preview Merge ────────────────────────────────────────────── */
async function previewMerge() {
    const keys = getSelectedMergeKeys();
    if (keys.length === 0) {
        toast("Select at least one merge key", "error");
        return;
    }

    const mappings = getColumnMappings();

    try {
        const res = await fetch(`/api/dashboards/${mergeDashId}/merge/preview`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                merge_keys: keys,
                how: _$("#merge-how").value,
                column_mappings: mappings,
            }),
        });
        const data = await res.json();

        const container = _$("#merge-preview");
        container.classList.remove("hidden");

        if (!data.ok) {
            container.innerHTML = `
                <div class="bg-red-900/30 border border-red-800 rounded-xl p-4">
                    <p class="text-sm text-red-400">${_esc(data.error)}</p>
                </div>`;
            return;
        }

        const cols = data.columns || [];
        const rows = data.preview || [];
        container.innerHTML = `
            <div class="bg-slate-900 rounded-xl border border-slate-800 overflow-hidden">
                <div class="px-4 py-3 border-b border-slate-800 flex items-center gap-2">
                    <svg class="w-4 h-4 text-blue-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"/></svg>
                    <span class="text-sm font-medium text-slate-300">Merge Preview</span>
                    <span class="text-xs text-slate-500">${data.rows} rows × ${data.cols} columns</span>
                </div>
                <div class="overflow-x-auto max-h-64">
                    <table class="preview-table">
                        <thead><tr>${cols.map((c) => `<th>${_esc(c)}</th>`).join("")}</tr></thead>
                        <tbody>${rows.map((r) =>
                            `<tr>${cols.map((c) => `<td>${_esc(String(r[c] ?? ""))}</td>`).join("")}</tr>`
                        ).join("")}</tbody>
                    </table>
                </div>
            </div>`;

        toast(`Preview: ${data.rows} rows × ${data.cols} cols`, "success");
    } catch (err) {
        toast(err.message, "error");
    }
}


/* ── Execute Merge ─────────────────────────────────────────────── */
async function executeMerge() {
    const keys = getSelectedMergeKeys();
    if (keys.length === 0) {
        toast("Select at least one merge key", "error");
        return;
    }

    const btn = _$("#step-merge .add-chart-btn");
    btn.disabled = true;
    btn.textContent = "Merging…";

    try {
        const res = await fetch(`/api/dashboards/${mergeDashId}/merge`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                merge_keys: keys,
                how: _$("#merge-how").value,
                column_mappings: getColumnMappings(),
            }),
        });
        if (!res.ok) {
            const err = await res.json();
            throw new Error(err.detail || "Merge failed");
        }
        const data = await res.json();
        currentMergeId = data.merge_id;

        // Show results section
        _$("#step-results").classList.remove("hidden");
        _$("#view-dashboard-btn").href = `/dashboard/${mergeDashId}`;

        // Info card
        _$("#merge-results-info").innerHTML = `
            <div class="flex gap-4 mb-4">
                <div class="stat-badge flex-1">
                    <div class="value">${data.rows.toLocaleString()}</div>
                    <div class="label">Rows</div>
                </div>
                <div class="stat-badge flex-1">
                    <div class="value">${data.cols}</div>
                    <div class="label">Columns</div>
                </div>
                <div class="stat-badge flex-1">
                    <div class="value">${data.charts?.length || 0}</div>
                    <div class="label">Charts Generated</div>
                </div>
            </div>`;

        // Merge log
        if (data.merge_log && data.merge_log.length > 0) {
            _$("#merge-log").innerHTML = `
                <div class="bg-slate-900 border border-slate-800 rounded-xl p-4">
                    <h3 class="text-sm font-medium text-slate-300 mb-3">Merge Log</h3>
                    <div class="space-y-1.5">
                        ${data.merge_log.map((l) => `
                            <div class="flex items-start gap-2 text-xs">
                                <span class="shrink-0 px-1.5 py-0.5 rounded font-mono
                                    ${l.action === 'summary' ? 'bg-emerald-900/50 text-emerald-400' : 'bg-slate-800 text-slate-400'}">
                                    ${_esc(l.action)}
                                </span>
                                <span class="text-slate-300">${_esc(l.detail)}</span>
                            </div>
                        `).join("")}
                    </div>
                </div>`;
        }

        // Preview table
        if (data.preview && data.preview.length > 0) {
            const cols = Object.keys(data.preview[0]);
            _$("#merged-preview").innerHTML = `
                <div class="bg-slate-900 rounded-xl border border-slate-800 overflow-hidden">
                    <div class="px-4 py-3 border-b border-slate-800">
                        <span class="text-sm font-medium text-slate-300">Merged Data Preview</span>
                    </div>
                    <div class="overflow-x-auto max-h-64">
                        <table class="preview-table">
                            <thead><tr>${cols.map((c) => `<th>${_esc(c)}</th>`).join("")}</tr></thead>
                            <tbody>${data.preview.map((r) =>
                                `<tr>${cols.map((c) => `<td>${_esc(String(r[c] ?? ""))}</td>`).join("")}</tr>`
                            ).join("")}</tbody>
                        </table>
                    </div>
                </div>`;
        }

        // Render merged charts
        if (data.charts && data.charts.length > 0) {
            renderCharts(data.charts, "#merged-charts-grid");
        }

        // Scroll to results
        _$("#step-results").scrollIntoView({ behavior: "smooth" });
        toast("Merge complete!", "success");
    } catch (err) {
        toast(err.message, "error");
    } finally {
        btn.disabled = false;
        btn.innerHTML = `<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 7h12m0 0l-4-4m4 4l-4 4m0 6H4m0 0l4 4m-4-4l4-4"/></svg> Merge & Generate Charts`;
    }
}


/* ── Export merged CSV ─────────────────────────────────────────── */
function exportMergedCSV() {
    if (!currentMergeId) {
        toast("No merge to export", "error");
        return;
    }
    const a = document.createElement("a");
    a.href = `/api/merges/${currentMergeId}/export/csv`;
    a.download = "merged_data.csv";
    document.body.appendChild(a);
    a.click();
    a.remove();
    toast("Downloading merged CSV…", "success");
}
