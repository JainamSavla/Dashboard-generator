/* ── merge.js ─────────────────────────────────────────────────
   Handles the Clean ▸ Relationships ▸ Map ▸ Merge workflow.
   Features: ER diagram with draggable tables, auto-detected
   PK/FK relationships, click-to-link columns, relationship-
   based merge via pairwise joins.
   ──────────────────────────────────────────────────────────── */

let mergeDashId = null;
let mergeColumnsData = null;   // { files, common_columns, suggested_relationships }
let currentMergeId = null;
let columnMappings = {};       // csv_file_id → { old: new }

/* Relationships: [{from_csv, from_column, to_csv, to_column, auto}] */
let relationships = [];

/* ER diagram state */
let erTablePositions = {};     // csv_file_id → { x, y }
let erDragging = null;         // { csvId, offsetX, offsetY }
let erLinkState = null;        // { csvId, column } — first click for linking

/* helper from app.js */
const _$ = (sel) => document.querySelector(sel);
const _esc = (str) => { const d = document.createElement("div"); d.textContent = str; return d.innerHTML; };

/* ══════════════════════════════════════════════════════════════
   INIT
   ══════════════════════════════════════════════════════════════ */
async function initMergePage(dashId) {
    mergeDashId = dashId;
    try {
        const res = await fetch("/api/dashboards/" + dashId + "/columns");
        if (!res.ok) throw new Error("Failed to load CSV info");
        mergeColumnsData = await res.json();

        if (mergeColumnsData.files.length < 2) {
            _$("#loading").innerHTML =
                '<div class="text-center py-20">'
                + '<p class="text-slate-400 text-lg mb-4">You need at least 2 CSVs to merge.</p>'
                + '<a href="/dashboard/' + dashId + '" class="add-chart-btn" style="text-decoration:none">← Back to Dashboard</a>'
                + '</div>';
            return;
        }

        _$("#merge-subtitle").textContent =
            mergeColumnsData.files.length + " CSV files · "
            + mergeColumnsData.common_columns.length + " common columns · "
            + (mergeColumnsData.suggested_relationships || []).length + " auto-detected relationships";

        _$("#loading").classList.add("hidden");
        _$("#step-clean").classList.remove("hidden");
        _$("#step-relationships").classList.remove("hidden");
        _$("#step-mapping").classList.remove("hidden");
        _$("#step-merge").classList.remove("hidden");

        // Seed relationships from auto-detected
        relationships = (mergeColumnsData.suggested_relationships || []).map(function(r) {
            return {
                from_csv: r.from_csv,
                from_column: r.from_column,
                to_csv: r.to_csv,
                to_column: r.to_column,
                auto: true,
            };
        });

        // Init column mappings
        columnMappings = {};
        mergeColumnsData.files.forEach(function(f) {
            columnMappings[f.csv_file_id] = {};
        });

        renderERDiagram();
        renderRelationshipsList();
        populateRelFormSelects();
        renderMappingUI();
        updateMergeSummary();
    } catch (err) {
        _$("#loading").innerHTML = '<p class="text-red-400 text-center py-20">' + _esc(err.message) + '</p>';
    }
}

/* ══════════════════════════════════════════════════════════════
   STEP 1: CLEAN (unchanged logic)
   ══════════════════════════════════════════════════════════════ */
async function cleanAllCSVs() {
    var opts = {
        numeric_strategy: _$("#clean-numeric").value,
        outlier_method: _$("#clean-outlier").value || null,
        normalize: _$("#clean-normalize").value || null,
    };

    var btn = _$("#step-clean .add-chart-btn");
    btn.disabled = true;
    btn.textContent = "Cleaning…";

    try {
        var res = await fetch("/api/dashboards/" + mergeDashId + "/clean-all", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(opts),
        });
        if (!res.ok) throw new Error("Cleaning failed");
        var data = await res.json();

        var container = _$("#clean-results");
        container.innerHTML = "";
        container.classList.remove("hidden");

        data.results.forEach(function(r) {
            if (r.error) {
                container.innerHTML +=
                    '<div class="bg-red-900/30 border border-red-800 rounded-xl p-4">'
                    + '<div class="text-sm font-medium text-red-400 mb-1">' + _esc(r.filename) + '</div>'
                    + '<p class="text-xs text-red-300">' + _esc(r.error) + '</p>'
                    + '</div>';
                return;
            }
            var logHtml = r.cleaning_log.map(function(l) {
                return '<div class="flex items-start gap-2 text-xs">'
                    + '<span class="shrink-0 px-1.5 py-0.5 rounded text-xs font-mono '
                    + (l.action === 'summary' ? 'bg-emerald-900/50 text-emerald-400' : 'bg-slate-800 text-slate-400')
                    + '">' + _esc(l.action) + '</span>'
                    + '<span class="text-slate-300">' + _esc(l.detail) + '</span>'
                    + '</div>';
            }).join("");

            container.innerHTML +=
                '<div class="bg-slate-900 border border-slate-800 rounded-xl p-4">'
                + '<div class="flex items-center gap-2 mb-3">'
                + '<svg class="w-4 h-4 text-emerald-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7"/></svg>'
                + '<span class="text-sm font-medium text-white">' + _esc(r.filename) + '</span>'
                + '<span class="text-xs text-slate-500">' + r.rows + ' rows × ' + r.cols + ' cols</span>'
                + '</div>'
                + '<div class="space-y-1.5">' + logHtml + '</div>'
                + '</div>';
        });

        // Refresh column data after cleaning
        var res2 = await fetch("/api/dashboards/" + mergeDashId + "/columns");
        if (res2.ok) {
            mergeColumnsData = await res2.json();
            renderERDiagram();
            renderRelationshipsList();
            populateRelFormSelects();
            renderMappingUI();
        }

        toast("All CSVs cleaned!", "success");
    } catch (err) {
        toast(err.message, "error");
    } finally {
        btn.disabled = false;
        btn.innerHTML = '<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7"/></svg> Clean All CSVs';
    }
}

/* ══════════════════════════════════════════════════════════════
   STEP 2: ER DIAGRAM + RELATIONSHIPS
   ══════════════════════════════════════════════════════════════ */

function getFileById(csvId) {
    return mergeColumnsData.files.find(function(f) { return f.csv_file_id === csvId; });
}

function getShortName(filename) {
    return filename.replace(/\.csv$/i, "");
}

/* Key classification helpers */
function isKeyColumn(col) {
    var n = col.name.toLowerCase();
    return n.endsWith("_id") || n === "id" || n.endsWith("id") || n.endsWith("_key") || n.endsWith("_code");
}

function getColumnKeyType(csvId, colName) {
    // Check candidate_keys
    var file = getFileById(csvId);
    if (!file) return null;
    var ck = (file.candidate_keys || []).find(function(k) { return k.column === colName; });
    if (ck) return ck.key_type; // "primary" or "candidate"

    // Check if it's used as FK in any relationship
    for (var i = 0; i < relationships.length; i++) {
        var r = relationships[i];
        if (r.from_csv === csvId && r.from_column === colName) return "fk";
        if (r.to_csv === csvId && r.to_column === colName) return "pk";
    }
    return null;
}


/* ── Render ER Diagram ───────────────────────────────────────── */
function renderERDiagram() {
    var container = _$("#er-diagram");
    if (!container) return;
    // Remove old table elements (keep SVG overlay)
    container.querySelectorAll(".er-table").forEach(function(el) { el.remove(); });

    var files = mergeColumnsData.files;
    var count = files.length;

    // Calculate positions in a circle layout if not set
    var canvasW = container.clientWidth || 900;
    var canvasH = container.clientHeight || 420;
    var centerX = canvasW / 2;
    var centerY = canvasH / 2;
    var radiusX = Math.min(canvasW * 0.35, 320);
    var radiusY = Math.min(canvasH * 0.3, 140);

    files.forEach(function(file, i) {
        if (!erTablePositions[file.csv_file_id]) {
            var angle = (2 * Math.PI * i) / count - Math.PI / 2;
            erTablePositions[file.csv_file_id] = {
                x: Math.round(centerX + radiusX * Math.cos(angle) - 95),
                y: Math.round(centerY + radiusY * Math.sin(angle) - 40),
            };
        }
    });

    files.forEach(function(file) {
        var pos = erTablePositions[file.csv_file_id];
        var div = document.createElement("div");
        div.className = "er-table";
        div.id = "er-table-" + file.csv_file_id;
        div.style.left = pos.x + "px";
        div.style.top = pos.y + "px";

        // Header
        var header = document.createElement("div");
        header.className = "er-table-header";
        header.innerHTML =
            '<svg class="w-3.5 h-3.5 text-indigo-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 7v10c0 2.21 3.582 4 8 4s8-1.79 8-4V7M4 7c0 2.21 3.582 4 8 4s8-1.79 8-4M4 7c0-2.21 3.582-4 8-4s8 1.79 8 4"/></svg>'
            + '<span class="truncate">' + _esc(getShortName(file.filename)) + '</span>';
        div.appendChild(header);

        // Body — columns
        var body = document.createElement("div");
        body.className = "er-table-body";

        file.columns.forEach(function(col) {
            var row = document.createElement("div");
            row.className = "er-col-row";
            row.setAttribute("data-csv", file.csv_file_id);
            row.setAttribute("data-col", col.name);

            var keyType = getColumnKeyType(file.csv_file_id, col.name);
            if (keyType === "primary" || keyType === "pk") {
                row.classList.add("pk");
            } else if (keyType === "fk" || keyType === "candidate") {
                row.classList.add("fk");
            }

            var badge = "";
            if (keyType === "primary" || keyType === "pk") {
                badge = '<span class="er-key-badge pk">PK</span>';
            } else if (keyType === "fk") {
                badge = '<span class="er-key-badge fk">FK</span>';
            } else if (keyType === "candidate") {
                badge = '<span class="er-key-badge fk">ID</span>';
            }

            row.innerHTML = badge
                + '<span class="truncate">' + _esc(col.name) + '</span>'
                + '<span class="er-col-type">' + col.dtype + '</span>';

            row.addEventListener("click", function(e) {
                e.stopPropagation();
                handleColumnClick(file.csv_file_id, col.name);
            });

            body.appendChild(row);
        });

        div.appendChild(body);
        container.appendChild(div);

        // Drag handlers
        header.addEventListener("mousedown", function(e) {
            e.preventDefault();
            var rect = div.getBoundingClientRect();
            erDragging = {
                csvId: file.csv_file_id,
                offsetX: e.clientX - rect.left,
                offsetY: e.clientY - rect.top,
            };
            div.classList.add("dragging");
        });
    });

    // Global mouse handlers for dragging
    document.removeEventListener("mousemove", onErMouseMove);
    document.removeEventListener("mouseup", onErMouseUp);
    document.addEventListener("mousemove", onErMouseMove);
    document.addEventListener("mouseup", onErMouseUp);

    drawRelationshipLines();
}

function onErMouseMove(e) {
    if (!erDragging) return;
    var container = _$("#er-diagram");
    var containerRect = container.getBoundingClientRect();
    var x = e.clientX - containerRect.left + container.scrollLeft - erDragging.offsetX;
    var y = e.clientY - containerRect.top + container.scrollTop - erDragging.offsetY;

    x = Math.max(0, x);
    y = Math.max(0, y);

    erTablePositions[erDragging.csvId] = { x: x, y: y };
    var el = _$("#er-table-" + erDragging.csvId);
    if (el) {
        el.style.left = x + "px";
        el.style.top = y + "px";
    }
    drawRelationshipLines();
}

function onErMouseUp() {
    if (erDragging) {
        var el = _$("#er-table-" + erDragging.csvId);
        if (el) el.classList.remove("dragging");
        erDragging = null;
    }
}


/* ── Click-to-link columns ───────────────────────────────────── */
function handleColumnClick(csvId, colName) {
    if (!erLinkState) {
        // First click
        erLinkState = { csvId: csvId, column: colName };
        // Highlight
        highlightColumn(csvId, colName, true);
        toast("Now click a column in another table to create a link", "success");
    } else {
        if (erLinkState.csvId === csvId) {
            // Same table — cancel
            highlightColumn(erLinkState.csvId, erLinkState.column, false);
            erLinkState = null;
            return;
        }
        // Second click — create relationship
        var rel = {
            from_csv: erLinkState.csvId,
            from_column: erLinkState.column,
            to_csv: csvId,
            to_column: colName,
            auto: false,
        };

        // Check for duplicate
        var dup = relationships.some(function(r) {
            return (
                (r.from_csv === rel.from_csv && r.from_column === rel.from_column
                    && r.to_csv === rel.to_csv && r.to_column === rel.to_column)
                || (r.from_csv === rel.to_csv && r.from_column === rel.to_column
                    && r.to_csv === rel.from_csv && r.to_column === rel.from_column)
            );
        });

        if (dup) {
            toast("This relationship already exists", "error");
        } else {
            relationships.push(rel);
            toast("Relationship added!", "success");
        }

        highlightColumn(erLinkState.csvId, erLinkState.column, false);
        erLinkState = null;

        renderERDiagram();
        renderRelationshipsList();
        updateMergeSummary();
    }
}

function highlightColumn(csvId, colName, on) {
    var rows = document.querySelectorAll('.er-col-row[data-csv="' + csvId + '"][data-col="' + colName + '"]');
    rows.forEach(function(r) {
        if (on) r.classList.add("selected-for-link");
        else r.classList.remove("selected-for-link");
    });
}


/* ── Draw SVG lines between related columns ──────────────────── */
function drawRelationshipLines() {
    var svg = _$("#er-lines");
    var container = _$("#er-diagram");
    if (!svg || !container) return;

    // Size SVG to container scroll area
    var scrollW = Math.max(container.scrollWidth, container.clientWidth);
    var scrollH = Math.max(container.scrollHeight, container.clientHeight);
    svg.setAttribute("width", scrollW);
    svg.setAttribute("height", scrollH);
    svg.innerHTML = "";

    // Add arrowhead marker
    svg.innerHTML = '<defs><marker id="arrowhead" markerWidth="8" markerHeight="6" refX="8" refY="3" orient="auto">'
        + '<polygon points="0 0, 8 3, 0 6" fill="#6366f1" opacity="0.7"/>'
        + '</marker></defs>';

    relationships.forEach(function(rel) {
        var fromEl = _$("#er-table-" + rel.from_csv);
        var toEl = _$("#er-table-" + rel.to_csv);
        if (!fromEl || !toEl) return;

        // Find column row positions
        var fromRow = fromEl.querySelector('.er-col-row[data-col="' + CSS.escape(rel.from_column) + '"]');
        var toRow = toEl.querySelector('.er-col-row[data-col="' + CSS.escape(rel.to_column) + '"]');

        var fromPos = getElementCenter(fromRow || fromEl, container);
        var toPos = getElementCenter(toRow || toEl, container);

        // Adjust x to edge of table
        var fromTableRight = fromEl.offsetLeft + fromEl.offsetWidth;
        var fromTableLeft = fromEl.offsetLeft;
        var toTableRight = toEl.offsetLeft + toEl.offsetWidth;
        var toTableLeft = toEl.offsetLeft;

        // Connect from right edge to left edge, or vice versa
        if (fromTableRight < toTableLeft) {
            fromPos.x = fromTableRight;
            toPos.x = toTableLeft;
        } else if (toTableRight < fromTableLeft) {
            fromPos.x = fromTableLeft;
            toPos.x = toTableRight;
        }

        var line = document.createElementNS("http://www.w3.org/2000/svg", "line");
        line.setAttribute("x1", fromPos.x);
        line.setAttribute("y1", fromPos.y);
        line.setAttribute("x2", toPos.x);
        line.setAttribute("y2", toPos.y);
        line.setAttribute("marker-end", "url(#arrowhead)");
        svg.appendChild(line);

        // Dot at start
        var dot = document.createElementNS("http://www.w3.org/2000/svg", "circle");
        dot.setAttribute("cx", fromPos.x);
        dot.setAttribute("cy", fromPos.y);
        dot.setAttribute("r", "3");
        svg.appendChild(dot);

        // Label in middle
        var midX = (fromPos.x + toPos.x) / 2;
        var midY = (fromPos.y + toPos.y) / 2 - 6;
        var label = document.createElementNS("http://www.w3.org/2000/svg", "text");
        label.setAttribute("x", midX);
        label.setAttribute("y", midY);
        label.setAttribute("text-anchor", "middle");
        label.setAttribute("fill", "#94a3b8");
        label.setAttribute("font-size", "9");
        label.setAttribute("font-family", "Inter, sans-serif");
        label.textContent = rel.from_column + (rel.from_column !== rel.to_column ? " ↔ " + rel.to_column : "");
        svg.appendChild(label);
    });
}

function getElementCenter(el, container) {
    if (!el) return { x: 0, y: 0 };
    var elRect = el.getBoundingClientRect();
    var contRect = container.getBoundingClientRect();
    return {
        x: elRect.left - contRect.left + container.scrollLeft + elRect.width / 2,
        y: elRect.top - contRect.top + container.scrollTop + elRect.height / 2,
    };
}


/* ── Relationships List & Form ───────────────────────────────── */
function renderRelationshipsList() {
    var container = _$("#relationships-list");
    if (!container) return;
    container.innerHTML = "";

    if (relationships.length === 0) {
        container.innerHTML = '<p class="text-xs text-slate-500">No relationships defined. Click columns in the ER diagram or use the form below.</p>';
        return;
    }

    relationships.forEach(function(rel, idx) {
        var fromFile = getFileById(rel.from_csv);
        var toFile = getFileById(rel.to_csv);
        var fromName = fromFile ? getShortName(fromFile.filename) : rel.from_csv.substring(0, 8);
        var toName = toFile ? getShortName(toFile.filename) : rel.to_csv.substring(0, 8);

        var card = document.createElement("div");
        card.className = "rel-card";
        card.innerHTML =
            '<span class="text-xs">'
            + '<span class="text-indigo-400 font-semibold">' + _esc(fromName) + '</span>'
            + '.<span class="text-slate-300">' + _esc(rel.from_column) + '</span>'
            + '</span>'
            + '<span class="rel-arrow">↔</span>'
            + '<span class="text-xs">'
            + '<span class="text-indigo-400 font-semibold">' + _esc(toName) + '</span>'
            + '.<span class="text-slate-300">' + _esc(rel.to_column) + '</span>'
            + '</span>'
            + (rel.auto ? '<span class="text-xs text-emerald-500 ml-2">auto</span>' : '')
            + '<button class="rel-remove-btn" onclick="removeRelationship(' + idx + ')" title="Remove">'
            + '<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"/></svg>'
            + '</button>';
        container.appendChild(card);
    });
}

function removeRelationship(idx) {
    relationships.splice(idx, 1);
    renderERDiagram();
    renderRelationshipsList();
    updateMergeSummary();
}

function populateRelFormSelects() {
    var fromCsv = _$("#rel-from-csv");
    var toCsv = _$("#rel-to-csv");
    if (!fromCsv || !toCsv) return;

    var opts = '<option value="">Select CSV…</option>';
    mergeColumnsData.files.forEach(function(f) {
        opts += '<option value="' + _esc(f.csv_file_id) + '">' + _esc(getShortName(f.filename)) + '</option>';
    });
    fromCsv.innerHTML = opts;
    toCsv.innerHTML = opts;
}

function populateRelColumns(selectId, csvId) {
    var sel = _$("#" + selectId);
    if (!sel) return;
    sel.innerHTML = '<option value="">Column…</option>';
    if (!csvId) return;

    var file = getFileById(csvId);
    if (!file) return;

    // Show key-like columns first
    var cols = file.columns.slice().sort(function(a, b) {
        var aKey = isKeyColumn(a) ? 0 : 1;
        var bKey = isKeyColumn(b) ? 0 : 1;
        return aKey - bKey;
    });

    cols.forEach(function(col) {
        var suffix = isKeyColumn(col) ? " ★" : "";
        sel.innerHTML += '<option value="' + _esc(col.name) + '">' + _esc(col.name) + ' (' + col.dtype + ')' + suffix + '</option>';
    });
}

function addRelationshipFromForm() {
    var fromCsv = _$("#rel-from-csv").value;
    var fromCol = _$("#rel-from-col").value;
    var toCsv = _$("#rel-to-csv").value;
    var toCol = _$("#rel-to-col").value;

    if (!fromCsv || !fromCol || !toCsv || !toCol) {
        toast("Fill in all fields", "error");
        return;
    }
    if (fromCsv === toCsv) {
        toast("Cannot link a table to itself", "error");
        return;
    }

    // Check duplicate
    var dup = relationships.some(function(r) {
        return (
            (r.from_csv === fromCsv && r.from_column === fromCol && r.to_csv === toCsv && r.to_column === toCol)
            || (r.from_csv === toCsv && r.from_column === toCol && r.to_csv === fromCsv && r.to_column === fromCol)
        );
    });

    if (dup) {
        toast("Relationship already exists", "error");
        return;
    }

    relationships.push({
        from_csv: fromCsv, from_column: fromCol,
        to_csv: toCsv, to_column: toCol,
        auto: false,
    });

    // Reset form
    _$("#rel-from-csv").value = "";
    _$("#rel-from-col").innerHTML = '<option value="">Column…</option>';
    _$("#rel-to-csv").value = "";
    _$("#rel-to-col").innerHTML = '<option value="">Column…</option>';

    renderERDiagram();
    renderRelationshipsList();
    updateMergeSummary();
    toast("Relationship added!", "success");
}


/* ══════════════════════════════════════════════════════════════
   STEP 3: COLUMN MAPPING (optional rename)
   ══════════════════════════════════════════════════════════════ */
function renderMappingUI() {
    var area = _$("#mapping-area");
    if (!area) return;
    area.innerHTML = "";

    mergeColumnsData.files.forEach(function(file) {
        var fId = file.csv_file_id;
        var cols = file.columns.map(function(c) { return c.name; });
        var colChips = cols.map(function(c) {
            var col = file.columns.find(function(x) { return x.name === c; });
            return '<span class="inline-flex items-center gap-1 bg-slate-800 rounded-full px-2.5 py-1 text-xs text-slate-300">'
                + _esc(c)
                + '<span class="text-slate-600">(' + (col ? col.dtype : '?') + ')</span>'
                + '</span>';
        }).join(" ");

        area.innerHTML +=
            '<div class="bg-slate-900 border border-slate-800 rounded-xl p-4">'
            + '<div class="flex items-center gap-2 mb-3">'
            + '<span class="text-sm font-medium text-indigo-400">' + _esc(getShortName(file.filename)) + '</span>'
            + '<span class="text-xs text-slate-500">(' + file.columns.length + ' columns)</span>'
            + '</div>'
            + '<div class="flex flex-wrap gap-1.5 mb-3">' + colChips + '</div>'
            + '<div id="mapping-rows-' + _esc(fId) + '" class="space-y-2"></div>'
            + '<button onclick="addMappingRow(\'' + _esc(fId) + '\')" class="text-xs text-indigo-400 hover:text-indigo-300 mt-2 transition">'
            + '+ Add column rename'
            + '</button>'
            + '</div>';
    });
}

function addMappingRow(fId) {
    var container = _$("#mapping-rows-" + fId);
    var file = getFileById(fId);
    if (!file) return;

    var row = document.createElement("div");
    row.className = "flex items-center gap-2";
    row.innerHTML =
        '<select class="modal-select flex-1 text-xs" data-fidx="' + _esc(fId) + '" data-role="from" onchange="updateMappingForFile(\'' + _esc(fId) + '\')">'
        + '<option value="">Rename from…</option>'
        + file.columns.map(function(c) { return '<option value="' + _esc(c.name) + '">' + _esc(c.name) + '</option>'; }).join("")
        + '</select>'
        + '<span class="text-slate-600">→</span>'
        + '<input type="text" class="modal-select flex-1 text-xs" placeholder="New name" data-fidx="' + _esc(fId) + '" data-role="to" oninput="updateMappingForFile(\'' + _esc(fId) + '\')">'
        + '<button onclick="this.parentElement.remove(); updateMappingForFile(\'' + _esc(fId) + '\')" class="text-slate-500 hover:text-red-400 transition">'
        + '<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"/></svg>'
        + '</button>';
    container.appendChild(row);
}

function updateMappingForFile(fId) {
    var container = _$("#mapping-rows-" + fId);
    if (!container) return;
    var mapping = {};
    container.querySelectorAll("div").forEach(function(row) {
        var from = row.querySelector("[data-role='from']");
        var to = row.querySelector("[data-role='to']");
        var fromVal = from ? from.value : "";
        var toVal = to ? to.value.trim() : "";
        if (fromVal && toVal) mapping[fromVal] = toVal;
    });
    columnMappings[fId] = mapping;
}


/* ══════════════════════════════════════════════════════════════
   STEP 4: MERGE (relationship-based)
   ══════════════════════════════════════════════════════════════ */
function updateMergeSummary() {
    var el = _$("#merge-rel-summary");
    if (el) {
        el.textContent = relationships.length + " relationship" + (relationships.length !== 1 ? "s" : "") + " defined";
    }
}

async function executeRelationshipMerge() {
    if (relationships.length === 0) {
        toast("Define at least one relationship first", "error");
        return;
    }

    var btn = _$("#step-merge .add-chart-btn");
    btn.disabled = true;
    btn.textContent = "Merging…";

    // Build clean relationships payload
    var rels = relationships.map(function(r) {
        return {
            from_csv: r.from_csv,
            from_column: r.from_column,
            to_csv: r.to_csv,
            to_column: r.to_column,
        };
    });

    // Collect column mappings
    mergeColumnsData.files.forEach(function(f) {
        updateMappingForFile(f.csv_file_id);
    });

    try {
        var res = await fetch("/api/dashboards/" + mergeDashId + "/merge/relationships", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                relationships: rels,
                how: _$("#merge-how").value,
                column_mappings: columnMappings,
            }),
        });
        if (!res.ok) {
            var errData = await res.json();
            throw new Error(errData.detail || "Merge failed");
        }
        var data = await res.json();
        currentMergeId = data.merge_id;

        // Show results section
        _$("#step-results").classList.remove("hidden");
        _$("#view-dashboard-btn").href = "/dashboard/" + mergeDashId;

        // Info card
        _$("#merge-results-info").innerHTML =
            '<div class="flex gap-4 mb-4">'
            + '<div class="stat-badge flex-1"><div class="value">' + data.rows.toLocaleString() + '</div><div class="label">Rows</div></div>'
            + '<div class="stat-badge flex-1"><div class="value">' + data.cols + '</div><div class="label">Columns</div></div>'
            + '<div class="stat-badge flex-1"><div class="value">' + (data.charts ? data.charts.length : 0) + '</div><div class="label">Charts Generated</div></div>'
            + '</div>';

        // Merge log
        if (data.merge_log && data.merge_log.length > 0) {
            _$("#merge-log").innerHTML =
                '<div class="bg-slate-900 border border-slate-800 rounded-xl p-4">'
                + '<h3 class="text-sm font-medium text-slate-300 mb-3">Merge Log</h3>'
                + '<div class="space-y-1.5">'
                + data.merge_log.map(function(l) {
                    var cls = l.action === 'summary' ? 'bg-emerald-900/50 text-emerald-400'
                        : l.action === 'warning' ? 'bg-yellow-900/50 text-yellow-400'
                        : 'bg-slate-800 text-slate-400';
                    return '<div class="flex items-start gap-2 text-xs">'
                        + '<span class="shrink-0 px-1.5 py-0.5 rounded font-mono ' + cls + '">' + _esc(l.action) + '</span>'
                        + '<span class="text-slate-300">' + _esc(l.detail) + '</span>'
                        + '</div>';
                }).join("")
                + '</div></div>';
        }

        // Preview table
        if (data.preview && data.preview.length > 0) {
            var cols = Object.keys(data.preview[0]);
            _$("#merged-preview").innerHTML =
                '<div class="bg-slate-900 rounded-xl border border-slate-800 overflow-hidden">'
                + '<div class="px-4 py-3 border-b border-slate-800"><span class="text-sm font-medium text-slate-300">Merged Data Preview</span></div>'
                + '<div class="overflow-x-auto max-h-64">'
                + '<table class="preview-table">'
                + '<thead><tr>' + cols.map(function(c) { return '<th>' + _esc(c) + '</th>'; }).join("") + '</tr></thead>'
                + '<tbody>' + data.preview.map(function(r) {
                    return '<tr>' + cols.map(function(c) { return '<td>' + _esc(String(r[c] != null ? r[c] : "")) + '</td>'; }).join("") + '</tr>';
                }).join("") + '</tbody>'
                + '</table></div></div>';
        }

        // Render merged charts
        if (data.charts && data.charts.length > 0) {
            renderCharts(data.charts, "#merged-charts-grid");
        }

        _$("#step-results").scrollIntoView({ behavior: "smooth" });
        toast("Merge complete!", "success");
    } catch (err) {
        toast(err.message, "error");
    } finally {
        btn.disabled = false;
        btn.innerHTML = '<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 7h12m0 0l-4-4m4 4l-4 4m0 6H4m0 0l4 4m-4-4l4-4"/></svg> Merge & Generate Charts';
    }
}


/* ══════════════════════════════════════════════════════════════
   EXPORT MERGED CSV
   ══════════════════════════════════════════════════════════════ */
function exportMergedCSV() {
    if (!currentMergeId) {
        toast("No merge to export", "error");
        return;
    }
    var a = document.createElement("a");
    a.href = "/api/merges/" + currentMergeId + "/export/csv";
    a.download = "merged_data.csv";
    document.body.appendChild(a);
    a.click();
    a.remove();
    toast("Downloading merged CSV…", "success");
}
