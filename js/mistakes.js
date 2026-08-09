import { escapeHtml, fileToDataURL } from './utils.js';
import { getAllMistakeChapters, saveMistakeEntry } from './storage.js';
import { SYLLABUS_SUBJECTS } from './syllabus.js';
// Forward reference — ui.js lands in Step 7. Only called inside function
// bodies, safe once the full module graph is wired in main.js.
import { showToast } from './ui.js';

// ----------------- STATE -----------------
let activeMistakeView = "add";              // "add" | "view"
let activeMistakeSubject = "Physics";       // View-tab subject filter
let addFormSubject = "Physics";             // Add-form subject picker
let addFormChapter = null;                  // Add-form chapter picker
let expandedMistakeChapters = {};
let editingMistakeChapters = {};           // View tab: which expanded chapters are in edit mode (default = read-only)
let mistakeSearchQuery = "";
let mistakeSortMode = "most";               // most | least | new | old
// Cache of key -> entry, refreshed at the start of every render so the
// synchronous HTML-building pass below doesn't need to be async itself.
let mistakeCache = {};
let delegationWired = false;

function keyFor(subject, chapter) { return subject + "|" + chapter; }
// DOM ids can't contain the characters chapter/subject names sometimes
// have (spaces, parens, /, etc.) — build a safe id from the key.
function safeId(key) { return "mistake-file-" + key.replace(/[^a-zA-Z0-9]/g, "_"); }

function blankEntry(subject, chapter) {
    return { key: keyFor(subject, chapter), subject, chapter, count: 0, notes: "", files: [], hasFiles: false, updatedAt: 0 };
}

// ----------------- SUB-TAB SWITCH -----------------
export function setMistakesView(view) {
    activeMistakeView = (view === "view") ? "view" : "add";
    renderMistakesTracker();
}

export function setMistakesSubject(subject) {
    // Subject names (Physics/Maths/OC/IOC/PC) are plain alnum strings with
    // no quotes/parens — safe to drive straight from an inline onclick, so
    // this stays a normal exported/window-exposed handler like syllabus.js's
    // setSyllabusSubject. Only the dynamic, chapter-name-bearing rows below
    // are routed through event delegation.
    activeMistakeSubject = subject;
    renderMistakesTracker();
}

export function setMistakeSort(mode) {
    mistakeSortMode = mode;
    renderMistakesTracker();
}

export function filterMistakeSearch(query) {
    mistakeSearchQuery = (query || "").toLowerCase();
    renderMistakesTracker();
}

// ----------------- ADD FORM -----------------
export function onAddSubjectChange() {
    let sel = document.getElementById("mistake-add-subject");
    addFormSubject = sel ? sel.value : addFormSubject;
    addFormChapter = null;
    renderMistakesTracker();
}

export function onAddChapterChange() {
    let sel = document.getElementById("mistake-add-chapter");
    addFormChapter = sel ? sel.value : null;
    renderMistakesTracker();
}

export async function saveAddMistake() {
    if (!addFormChapter) { alert("Pick a chapter first."); return; }
    let countInput = document.getElementById("mistake-add-count");
    let notesInput = document.getElementById("mistake-add-notes");
    let filesInput = document.getElementById("mistake-add-files");

    let n = parseInt(countInput ? countInput.value : "1", 10);
    if (isNaN(n) || n < 1) n = 1;
    let notes = notesInput ? notesInput.value.trim() : "";
    if (!notes) { alert("Notes are required — jot down what went wrong."); return; }

    let key = keyFor(addFormSubject, addFormChapter);
    let entry = mistakeCache[key] || blankEntry(addFormSubject, addFormChapter);
    entry.count = (entry.count || 0) + n;
    let stamp = new Date().toLocaleString();
    entry.notes = entry.notes ? `${entry.notes}\n[${stamp}] ${notes}` : `[${stamp}] ${notes}`;
    if (filesInput && filesInput.files && filesInput.files.length > 0) {
        if (!entry.files) entry.files = [];
        for (let f of filesInput.files) entry.files.push(await fileToDataURL(f));
        entry.hasFiles = entry.files.length > 0;
    }
    entry.updatedAt = Date.now();
    await saveMistakeEntry(entry);
    mistakeCache[key] = entry;

    if (countInput) countInput.value = "1";
    if (notesInput) notesInput.value = "";
    if (filesInput) filesInput.value = "";
    showToast(`Mistake logged for ${addFormChapter}.`);
    renderMistakesTracker();
}

// ----------------- VIEW LIST: per-chapter actions -----------------
// All of these take the already-decoded subject/chapter strings straight
// from element.dataset (the browser decodes HTML-attribute entities for
// us) — never reconstructed from a hand-escaped JS string literal, so
// parens, slashes, commas, and quotes in chapter names ("Electromagnetic
// Induction (EMI)", "Aldehydes/Ketones/Carboxylic Acids") can never break
// the handler the way embedding them in onclick="...('...')" could.
async function doToggleExpand(subject, chapter) {
    let key = keyFor(subject, chapter);
    expandedMistakeChapters[key] = !expandedMistakeChapters[key];
    if (!expandedMistakeChapters[key]) editingMistakeChapters[key] = false; // reset to read-only when collapsed
    renderMistakesTracker();
}

// Pencil ⇄ Save toggle inside an expanded chapter's detail panel: View
// Mistakes stays read-only by default (matches the mock-test entry look);
// clicking the pencil switches that one chapter into the editable form,
// clicking the save icon switches it back to the read-only view.
async function doToggleEditMode(subject, chapter) {
    let key = keyFor(subject, chapter);
    editingMistakeChapters[key] = !editingMistakeChapters[key];
    renderMistakesTracker();
}

async function doUpdateCount(subject, chapter, value) {
    let key = keyFor(subject, chapter);
    let entry = mistakeCache[key] || blankEntry(subject, chapter);
    let n = parseInt(value, 10);
    entry.count = (isNaN(n) || n < 0) ? 0 : n;
    entry.updatedAt = Date.now();
    await saveMistakeEntry(entry);
    mistakeCache[key] = entry;
    renderMistakesTracker();
}

async function doSaveNotes(subject, chapter, value) {
    let key = keyFor(subject, chapter);
    let entry = mistakeCache[key] || blankEntry(subject, chapter);
    entry.notes = value;
    entry.updatedAt = Date.now();
    await saveMistakeEntry(entry);
    mistakeCache[key] = entry;
    // No re-render needed — avoids yanking focus out of the textarea the
    // user is still typing in (change only fires when they leave it).
}

async function doAddFiles(subject, chapter) {
    let key = keyFor(subject, chapter);
    let input = document.getElementById(safeId(key));
    if (!input || !input.files || input.files.length === 0) return;
    let entry = mistakeCache[key] || blankEntry(subject, chapter);
    if (!entry.files) entry.files = [];
    for (let f of input.files) entry.files.push(await fileToDataURL(f));
    entry.hasFiles = entry.files.length > 0;
    entry.updatedAt = Date.now();
    await saveMistakeEntry(entry);
    mistakeCache[key] = entry;
    input.value = "";
    showToast("Attachment added.");
    renderMistakesTracker();
}

async function doRemoveFile(subject, chapter, idx) {
    let key = keyFor(subject, chapter);
    let entry = mistakeCache[key];
    if (!entry) return;
    // Same cross-device guard as mock tests' deleteMockTestEntry(): if the
    // cloud says this chapter has attachments but this browser's IndexedDB
    // doesn't actually hold them (attached on a different device — file
    // bytes never sync, see firebase-sync.js), there is nothing local to
    // remove, and clearing the entry's hasFiles flag here would make the
    // next sync push silently erase the record of that attachment for the
    // browser that actually has it.
    if (entry.hasFiles && (!entry.files || entry.files.length === 0)) {
        alert("This chapter has an attachment on a different browser/device (not this one). Remove it from the browser where the file actually is.");
        return;
    }
    if (!confirm("Remove this attachment?")) return;
    entry.files.splice(idx, 1);
    entry.hasFiles = entry.files.length > 0;
    entry.updatedAt = Date.now();
    await saveMistakeEntry(entry);
    mistakeCache[key] = entry;
    renderMistakesTracker();
}

async function doDeleteChapterLog(subject, chapter) {
    let key = keyFor(subject, chapter);
    let entry = mistakeCache[key];
    if (!entry) return;
    // Same guard as doRemoveFile — never let a delete wipe an attachment
    // that only exists on another browser/device.
    if (entry.hasFiles && (!entry.files || entry.files.length === 0)) {
        alert("This chapter has an attachment on a different browser/device (not this one). Delete it from the browser where the file actually is.");
        return;
    }
    if (!confirm("Clear all mistakes logged for this chapter?")) return;
    let cleared = blankEntry(subject, chapter);
    cleared.updatedAt = Date.now();
    await saveMistakeEntry(cleared);
    mistakeCache[key] = cleared;
    renderMistakesTracker();
}

// ----------------- EVENT DELEGATION -----------------
// Wiring these once on the panel container (rather than baking chapter
// names into inline onclick="...('...')" strings, as the per-chapter rows
// used to) is the actual root-cause fix for the escaping bug: attribute
// values below go through escapeHtml() and are read back via
// element.dataset, which the browser decodes for us — parens, slashes,
// commas and quotes in a chapter name can never break a handler this way.
function wireDelegationOnce() {
    if (delegationWired) return;
    let panel = document.getElementById("panel-mistakes");
    if (!panel) return;
    delegationWired = true;

    panel.addEventListener("click", (e) => {
        let removeBtn = e.target.closest("[data-mc-remove-file]");
        if (removeBtn) {
            let card = removeBtn.closest(".mistake-chapter-card");
            doRemoveFile(card.dataset.subject, card.dataset.chapter, parseInt(removeBtn.dataset.mcRemoveFile, 10));
            return;
        }
        let addBtn = e.target.closest("[data-mc-add-files]");
        if (addBtn) {
            let card = addBtn.closest(".mistake-chapter-card");
            doAddFiles(card.dataset.subject, card.dataset.chapter);
            return;
        }
        let delBtn = e.target.closest("[data-mc-delete-log]");
        if (delBtn) {
            let card = delBtn.closest(".mistake-chapter-card");
            doDeleteChapterLog(card.dataset.subject, card.dataset.chapter);
            return;
        }
        let editToggleBtn = e.target.closest("[data-mc-edit-toggle]");
        if (editToggleBtn) {
            let card = editToggleBtn.closest(".mistake-chapter-card");
            doToggleEditMode(card.dataset.subject, card.dataset.chapter);
            return;
        }
        // The expandable detail panel sits alongside (not inside) mc-top in
        // the DOM, so clicks inside it never bubble into mc-top's handler —
        // this guard just keeps that true if the markup nesting ever changes.
        if (e.target.closest(".mc-detail")) return;
        let top = e.target.closest(".mc-top");
        if (top) {
            let card = top.closest(".mistake-chapter-card");
            doToggleExpand(card.dataset.subject, card.dataset.chapter);
        }
    });

    panel.addEventListener("change", (e) => {
        if (e.target.matches(".mc-count-input")) {
            let card = e.target.closest(".mistake-chapter-card");
            doUpdateCount(card.dataset.subject, card.dataset.chapter, e.target.value);
        } else if (e.target.matches(".mc-notes")) {
            let card = e.target.closest(".mistake-chapter-card");
            doSaveNotes(card.dataset.subject, card.dataset.chapter, e.target.value);
        }
    });
}

// ----------------- RENDER -----------------
function sortChapterRows(rows, mode) {
    let arr = rows.slice();
    switch (mode) {
        case "least": arr.sort((a, b) => (a.entry.count || 0) - (b.entry.count || 0)); break;
        case "new": arr.sort((a, b) => (b.entry.updatedAt || 0) - (a.entry.updatedAt || 0)); break;
        case "old": arr.sort((a, b) => (a.entry.updatedAt || 0) - (b.entry.updatedAt || 0)); break;
        case "most":
        default: arr.sort((a, b) => (b.entry.count || 0) - (a.entry.count || 0)); break;
    }
    return arr;
}

function renderAddForm() {
    let subjects = Object.keys(SYLLABUS_SUBJECTS);
    if (!addFormChapter) {
        let firstList = [...(SYLLABUS_SUBJECTS[addFormSubject][11] || []), ...(SYLLABUS_SUBJECTS[addFormSubject][12] || [])];
        addFormChapter = firstList[0] || null;
    }
    let chapterOptions = [11, 12].flatMap(cls => (SYLLABUS_SUBJECTS[addFormSubject][cls] || []).map(ch => ({ cls, ch })));

    let html = `<div class="card" style="padding:12px;">
        <label style="font-size:12px; color:var(--muted);">Subject</label>
        <select id="mistake-add-subject" class="sort-select" style="width:100%; max-width:none;" onchange="onAddSubjectChange()">
            ${subjects.map(s => `<option value="${escapeHtml(s)}" ${s === addFormSubject ? 'selected' : ''}>${escapeHtml(s)}</option>`).join('')}
        </select>
        <label style="font-size:12px; color:var(--muted); margin-top:8px; display:block;">Chapter</label>
        <select id="mistake-add-chapter" class="sort-select" style="width:100%; max-width:none;" onchange="onAddChapterChange()">
            ${chapterOptions.map(o => `<option value="${escapeHtml(o.ch)}" ${o.ch === addFormChapter ? 'selected' : ''}>Class ${o.cls} · ${escapeHtml(o.ch)}</option>`).join('')}
        </select>
        <div style="display:flex; align-items:center; gap:10px; margin-top:12px;">
            <span class="mc-name" style="flex:1;">${escapeHtml(addFormChapter || "—")}</span>
            <input type="number" id="mistake-add-count" min="1" step="1" value="1" style="width:70px;" title="Mistakes to log">
        </div>
        <label style="font-size:12px; color:var(--muted); margin-top:8px; display:block;">Notes (required)</label>
        <textarea id="mistake-add-notes" class="mc-notes" placeholder="What went wrong, how to fix it..."></textarea>
        <label style="font-size:12px; color:var(--muted); margin-top:8px; display:block;">Attach files (optional)</label>
        <input type="file" id="mistake-add-files" accept="image/*,application/pdf" multiple>
        <button type="button" class="btn btn-start" style="width:100%; margin-top:12px;" onclick="saveAddMistake()">Log Mistake</button>
    </div>`;
    document.getElementById("mistake-add-wrap").innerHTML = html;
}

function renderViewList() {
    let subjects = Object.keys(SYLLABUS_SUBJECTS);
    document.getElementById("mistake-subject-tabs").innerHTML = subjects.map(s =>
        `<button class="${s === activeMistakeSubject ? 'active' : ''}" onclick="setMistakesSubject('${s}')">${escapeHtml(s)}</button>`
    ).join('');

    let allEntries = Object.values(mistakeCache);
    let totalMistakes = allEntries.reduce((sum, e) => sum + (e.count || 0), 0);
    let bySubject = {};
    allEntries.forEach(e => { bySubject[e.subject] = (bySubject[e.subject] || 0) + (e.count || 0); });
    document.getElementById("mistake-overall").innerHTML =
        `<div>Total mistakes logged: <span class="highlight-text">${totalMistakes}</span></div>
         <div class="small-note">This subject: <span class="highlight-text" style="font-size:12px;">${bySubject[activeMistakeSubject] || 0}</span></div>`;

    let rows = [];
    [11, 12].forEach(cls => {
        (SYLLABUS_SUBJECTS[activeMistakeSubject][cls] || []).forEach(ch => {
            if (mistakeSearchQuery && !ch.toLowerCase().includes(mistakeSearchQuery)) return;
            let key = keyFor(activeMistakeSubject, ch);
            rows.push({ cls, ch, entry: mistakeCache[key] || blankEntry(activeMistakeSubject, ch) });
        });
    });
    rows = sortChapterRows(rows, mistakeSortMode);
    // Class 11/12 group headers only make sense when chapters stay in their
    // natural class order — most/least/new/old sorting deliberately mixes
    // class 11 and 12 chapters together by count or recency, so headers are
    // skipped for those modes rather than printing a misleading "Class 11"
    // label above a class-12 chapter.
    let showClassHeaders = false;

    let html = "";
    let lastCls = null;
    rows.forEach(({ cls, ch, entry }) => {
        if (showClassHeaders && cls !== lastCls) {
            html += `<div class="syllabus-class-header">Class ${cls}</div>`;
            lastCls = cls;
        }
        let key = keyFor(activeMistakeSubject, ch);
        let isExpanded = !!expandedMistakeChapters[key];
        let isEditing = isExpanded && !!editingMistakeChapters[key];
        let attachedElsewhere = entry.hasFiles && (!entry.files || entry.files.length === 0);

        html += `<div class="mistake-chapter-card ${isExpanded ? 'expanded' : ''}" data-subject="${escapeHtml(activeMistakeSubject)}" data-chapter="${escapeHtml(ch)}">
            <div class="mc-top">
                <span class="mc-name">${escapeHtml(ch)}</span>
                <span class="mc-badge" style="color:var(--danger); border-color:var(--danger);">${entry.count || 0}</span>
            </div>`;

        if (isExpanded && !isEditing) {
            // ----- READ-ONLY VIEW (default) -----
            html += `<div class="mc-detail">
                <div style="display:flex; align-items:center; justify-content:space-between; gap:8px;">
                    <span style="font-size:12px; color:var(--muted);">Mistakes made: <strong style="color:var(--danger); font-size:14px;">${entry.count || 0}</strong></span>
                    <button type="button" class="mc-icon-btn" data-mc-edit-toggle title="Edit this chapter's log">✏️</button>
                </div>
                <div class="mc-notes-view">${entry.notes ? escapeHtml(entry.notes) : '<span style="color:var(--muted);">No notes yet.</span>'}</div>
                ${((entry.files && entry.files.length) || attachedElsewhere) ? `<div class="mc-file-list">
                    ${(entry.files || []).map(f => f.type.startsWith('image/')
                        ? `<span class="mc-file-chip"><img src="${f.dataUrl}"></span>`
                        : `<span class="mc-file-chip mc-file-pdf"><a href="${f.dataUrl}" download="${escapeHtml(f.name)}">📄 ${escapeHtml(f.name)}</a></span>`
                    ).join('')}
                    ${attachedElsewhere ? `<span class="small-note" style="font-style:italic;">📎 File Attached on another browser</span>` : ''}
                </div>` : ''}
            </div>`;
        } else if (isEditing) {
            // ----- EDITABLE FORM (entered via the pencil icon) -----
            html += `<div class="mc-detail">
                <div style="display:flex; align-items:center; justify-content:space-between; gap:8px;">
                    <label style="font-size:12px; color:var(--muted); margin:0;">Mistakes made</label>
                    <button type="button" class="mc-icon-btn" data-mc-edit-toggle title="Done editing">💾</button>
                </div>
                <input type="number" min="0" step="1" class="mc-count-input" value="${entry.count || 0}">
                <label style="font-size:12px; color:var(--muted);">Notes</label>
                <textarea class="mc-notes" placeholder="What went wrong, how to fix it...">${escapeHtml(entry.notes || "")}</textarea>
                <label style="font-size:12px; color:var(--muted);">Attach files (images / PDFs)</label>
                <div class="mc-files-row">
                    <input type="file" id="${safeId(key)}" accept="image/*,application/pdf" multiple>
                    <button type="button" class="btn btn-start btn-small" data-mc-add-files>Add</button>
                </div>
                <div class="mc-file-list">
                    ${(entry.files || []).map((f, i) => f.type.startsWith('image/')
                        ? `<span class="mc-file-chip"><img src="${f.dataUrl}"><button type="button" data-mc-remove-file="${i}">✕</button></span>`
                        : `<span class="mc-file-chip mc-file-pdf"><a href="${f.dataUrl}" download="${escapeHtml(f.name)}">📄 ${escapeHtml(f.name)}</a><button type="button" data-mc-remove-file="${i}">✕</button></span>`
                    ).join('')}
                    ${attachedElsewhere ? `<span class="small-note" style="font-style:italic;">📎 File Attached on another browser</span>` : ''}
                </div>
                <button type="button" class="btn btn-stop btn-small" style="margin-top:8px;" data-mc-delete-log>Clear this chapter's log</button>
            </div>`;
        }
        html += `</div>`;
    });
    document.getElementById("mistake-chapter-list").innerHTML = html || `<div class="small-note" style="margin-top:10px;">No chapters match.</div>`;
}

export async function renderMistakesTracker() {
    wireDelegationOnce();
    let list = await getAllMistakeChapters();
    mistakeCache = {};
    list.forEach(e => { mistakeCache[e.key] = e; });

    let addTabEl = document.getElementById("mistake-tab-add");
    let viewTabEl = document.getElementById("mistake-tab-view");
    let addWrap = document.getElementById("mistake-add-wrap");
    let viewWrap = document.getElementById("mistake-view-wrap");
    if (addTabEl && viewTabEl && addWrap && viewWrap) {
        addTabEl.classList.toggle("active", activeMistakeView === "add");
        viewTabEl.classList.toggle("active", activeMistakeView === "view");
        addWrap.style.display = (activeMistakeView === "add") ? "block" : "none";
        viewWrap.style.display = (activeMistakeView === "view") ? "block" : "none";
    }

    if (activeMistakeView === "add") renderAddForm();
    else renderViewList();
}
