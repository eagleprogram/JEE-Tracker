import { escapeHtml, fileToDataURL, getTodayKey, downloadBlob } from './utils.js';
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
// View tab: which (chapter-key + entry-id) pairs are in edit mode (default
// = read-only). Keyed per-entry now, not per-chapter, since each mistake
// logged for a chapter is its own separately editable block.
let editingEntries = {};
let mistakeSearchQuery = "";
let mistakeSortMode = "most";               // most | least | new | old
// Cache of chapter-key -> stored record, refreshed at the start of every
// render so the synchronous HTML-building pass below doesn't need to be
// async itself.
let mistakeCache = {};
let delegationWired = false;

function keyFor(subject, chapter) { return subject + "|" + chapter; }
function entryKey(chapterKey, entryId) { return chapterKey + "::" + entryId; }
// DOM ids can't contain the characters chapter/subject names sometimes
// have (spaces, parens, /, etc.) — build a safe id from the key.
function safeId(key) { return "mistake-file-" + key.replace(/[^a-zA-Z0-9]/g, "_"); }

// A chapter's record now holds an ARRAY of separately-logged mistake
// entries, each with its own notes/files/count, instead of one blob whose
// notes were all concatenated together. blankRecord() is what a chapter
// with nothing logged yet looks like.
function blankRecord(subject, chapter) {
    return { key: keyFor(subject, chapter), subject, chapter, entries: [], updatedAt: 0 };
}

// Older saved records (before this change) had a single flat
// {count, notes, files, hasFiles, updatedAt} shape instead of an `entries`
// array. Rather than try to split that one concatenated notes string back
// into the original separate submissions (the boundaries aren't reliably
// recoverable, and guessing wrong would scramble real data), everything
// that chapter had logged so far is kept exactly as-is, as ONE entry. Any
// *new* mistake logged for that chapter from now on becomes its own
// separate entry alongside it.
export function normalizeRecord(rec) {
    if (!rec) return null;
    if (Array.isArray(rec.entries)) return rec;
    let hasLegacyData = (rec.count || 0) > 0 || (rec.notes && rec.notes.trim()) || (rec.files && rec.files.length);
    let entries = hasLegacyData ? [{
        id: "legacy",
        notes: rec.notes || "",
        files: rec.files || [],
        hasFiles: !!rec.hasFiles,
        count: rec.count || 1,
        createdAt: rec.updatedAt || Date.now()
    }] : [];
    return { key: rec.key, subject: rec.subject, chapter: rec.chapter, entries, updatedAt: rec.updatedAt || 0 };
}

function totalCount(rec) {
    return (rec.entries || []).reduce((sum, e) => sum + (e.count || 1), 0);
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
    let notesInput = document.getElementById("mistake-add-notes");
    let filesInput = document.getElementById("mistake-add-files");

    let notes = notesInput ? notesInput.value.trim() : "";
    if (!notes) { alert("Notes are required — jot down what went wrong."); return; }

    let key = keyFor(addFormSubject, addFormChapter);
    let record = mistakeCache[key] || blankRecord(addFormSubject, addFormChapter);
    let files = [];
    if (filesInput && filesInput.files && filesInput.files.length > 0) {
        for (let f of filesInput.files) files.push(await fileToDataURL(f));
    }
    // Each "Log Mistake" is its own separate entry — the chapter's total
    // (shown on the collapsed row) is just how many entries exist, summed
    // by their individual counts. No manual count field to fill in.
    record.entries.push({
        id: Date.now(),
        notes,
        files,
        hasFiles: files.length > 0,
        count: 1,
        createdAt: Date.now()
    });
    record.updatedAt = Date.now();
    await saveMistakeEntry(record);
    mistakeCache[key] = record;

    if (notesInput) notesInput.value = "";
    if (filesInput) filesInput.value = "";
    showToast(`Mistake logged for ${addFormChapter}.`);
    renderMistakesTracker();
}

// ----------------- VIEW LIST: per-entry actions -----------------
// All of these take the already-decoded subject/chapter/entryId straight
// from element.dataset (the browser decodes HTML-attribute entities for
// us) — never reconstructed from a hand-escaped JS string literal, so
// parens, slashes, commas, and quotes in a chapter name ("Electromagnetic
// Induction (EMI)", "Aldehydes/Ketones/Carboxylic Acids") can never break
// the handler the way embedding them in onclick="...('...')" could.
async function doToggleExpand(subject, chapter) {
    let key = keyFor(subject, chapter);
    expandedMistakeChapters[key] = !expandedMistakeChapters[key];
    if (!expandedMistakeChapters[key]) {
        // Reset every entry in this chapter back to read-only when collapsed.
        Object.keys(editingEntries).forEach(k => { if (k.startsWith(key + "::")) delete editingEntries[k]; });
    }
    renderMistakesTracker();
}

function findEntry(record, entryId) {
    return (record.entries || []).find(e => String(e.id) === String(entryId));
}

// Pencil ⇄ Save toggle inside one entry block: entries stay read-only by
// default (matches the mock-test entry look); clicking the pencil switches
// that one entry into an editable form, clicking the save icon switches it
// back to read-only.
async function doToggleEditMode(subject, chapter, entryId) {
    let ek = entryKey(keyFor(subject, chapter), entryId);
    editingEntries[ek] = !editingEntries[ek];
    renderMistakesTracker();
}

async function doUpdateEntryCount(subject, chapter, entryId, value) {
    let key = keyFor(subject, chapter);
    let record = mistakeCache[key];
    if (!record) return;
    let entry = findEntry(record, entryId);
    if (!entry) return;
    let n = parseInt(value, 10);
    entry.count = (isNaN(n) || n < 1) ? 1 : n;
    record.updatedAt = Date.now();
    await saveMistakeEntry(record);
    mistakeCache[key] = record;
    renderMistakesTracker();
}

async function doSaveEntryNotes(subject, chapter, entryId, value) {
    let key = keyFor(subject, chapter);
    let record = mistakeCache[key];
    if (!record) return;
    let entry = findEntry(record, entryId);
    if (!entry) return;
    entry.notes = value;
    record.updatedAt = Date.now();
    await saveMistakeEntry(record);
    mistakeCache[key] = record;
    // No re-render needed — avoids yanking focus out of the textarea the
    // user is still typing in (change only fires when they leave it).
}

async function doAddFilesToEntry(subject, chapter, entryId) {
    let key = keyFor(subject, chapter);
    let ek = entryKey(key, entryId);
    let input = document.getElementById(safeId(ek));
    if (!input || !input.files || input.files.length === 0) return;
    let record = mistakeCache[key];
    if (!record) return;
    let entry = findEntry(record, entryId);
    if (!entry) return;
    if (!entry.files) entry.files = [];
    for (let f of input.files) entry.files.push(await fileToDataURL(f));
    entry.hasFiles = entry.files.length > 0;
    record.updatedAt = Date.now();
    await saveMistakeEntry(record);
    mistakeCache[key] = record;
    input.value = "";
    showToast("Attachment added.");
    renderMistakesTracker();
}

async function doRemoveFileFromEntry(subject, chapter, entryId, idx) {
    let key = keyFor(subject, chapter);
    let record = mistakeCache[key];
    if (!record) return;
    let entry = findEntry(record, entryId);
    if (!entry) return;
    // Same cross-device guard as mock tests' deleteMockTestEntry(): if the
    // cloud says this entry has attachments but this browser's IndexedDB
    // doesn't actually hold them (attached on a different device — file
    // bytes never sync), there is nothing local to remove, and clearing
    // the entry's hasFiles flag here would make the next sync push
    // silently erase the record of that attachment for the browser that
    // actually has it.
    if (entry.hasFiles && (!entry.files || entry.files.length === 0)) {
        alert("This entry has an attachment on a different browser/device (not this one). Remove it from the browser where the file actually is.");
        return;
    }
    if (!confirm("Remove this attachment?")) return;
    entry.files.splice(idx, 1);
    entry.hasFiles = entry.files.length > 0;
    record.updatedAt = Date.now();
    await saveMistakeEntry(record);
    mistakeCache[key] = record;
    renderMistakesTracker();
}

async function doDeleteEntry(subject, chapter, entryId) {
    let key = keyFor(subject, chapter);
    let record = mistakeCache[key];
    if (!record) return;
    let entry = findEntry(record, entryId);
    if (!entry) return;
    // Same guard as doRemoveFileFromEntry — never let a delete wipe an
    // attachment that only exists on another browser/device.
    if (entry.hasFiles && (!entry.files || entry.files.length === 0)) {
        alert("This entry has an attachment on a different browser/device (not this one). Delete it from the browser where the file actually is.");
        return;
    }
    if (!confirm("Delete this mistake entry?")) return;
    record.entries = record.entries.filter(e => String(e.id) !== String(entryId));
    record.updatedAt = Date.now();
    await saveMistakeEntry(record);
    mistakeCache[key] = record;
    delete editingEntries[entryKey(key, entryId)];
    renderMistakesTracker();
}

async function doDeleteChapterLog(subject, chapter) {
    let key = keyFor(subject, chapter);
    let record = mistakeCache[key];
    if (!record) return;
    // Never let a bulk clear wipe an attachment that only exists on
    // another browser/device — same guard as the per-entry delete.
    let blockedByRemoteFile = (record.entries || []).some(e => e.hasFiles && (!e.files || e.files.length === 0));
    if (blockedByRemoteFile) {
        alert("One or more entries in this chapter have an attachment on a different browser/device (not this one). Delete those individually from the browser where the file actually is.");
        return;
    }
    if (!confirm("Clear ALL mistake entries logged for this chapter?")) return;
    let cleared = blankRecord(subject, chapter);
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
            let block = removeBtn.closest(".mc-entry-block");
            let card = removeBtn.closest(".mistake-chapter-card");
            doRemoveFileFromEntry(card.dataset.subject, card.dataset.chapter, block.dataset.entryId, parseInt(removeBtn.dataset.mcRemoveFile, 10));
            return;
        }
        let addBtn = e.target.closest("[data-mc-add-files]");
        if (addBtn) {
            let block = addBtn.closest(".mc-entry-block");
            let card = addBtn.closest(".mistake-chapter-card");
            doAddFilesToEntry(card.dataset.subject, card.dataset.chapter, block.dataset.entryId);
            return;
        }
        let delEntryBtn = e.target.closest("[data-mc-delete-entry]");
        if (delEntryBtn) {
            let block = delEntryBtn.closest(".mc-entry-block");
            let card = delEntryBtn.closest(".mistake-chapter-card");
            doDeleteEntry(card.dataset.subject, card.dataset.chapter, block.dataset.entryId);
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
            let block = editToggleBtn.closest(".mc-entry-block");
            let card = editToggleBtn.closest(".mistake-chapter-card");
            doToggleEditMode(card.dataset.subject, card.dataset.chapter, block.dataset.entryId);
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
            let block = e.target.closest(".mc-entry-block");
            let card = e.target.closest(".mistake-chapter-card");
            doUpdateEntryCount(card.dataset.subject, card.dataset.chapter, block.dataset.entryId, e.target.value);
        } else if (e.target.matches(".mc-notes")) {
            let block = e.target.closest(".mc-entry-block");
            let card = e.target.closest(".mistake-chapter-card");
            doSaveEntryNotes(card.dataset.subject, card.dataset.chapter, block.dataset.entryId, e.target.value);
        }
    });
}

// ----------------- RENDER -----------------
function sortChapterRows(rows, mode) {
    let arr = rows.slice();
    switch (mode) {
        case "least": arr.sort((a, b) => totalCount(a.record) - totalCount(b.record)); break;
        case "new": arr.sort((a, b) => (b.record.updatedAt || 0) - (a.record.updatedAt || 0)); break;
        case "old": arr.sort((a, b) => (a.record.updatedAt || 0) - (b.record.updatedAt || 0)); break;
        case "most":
        default: arr.sort((a, b) => totalCount(b.record) - totalCount(a.record)); break;
    }
    return arr;
}

// Wires "type a letter to jump to a matching chapter" onto the chapter
// <select>. Real <select> elements already do this natively on desktop, but
// it's flaky-to-absent on several mobile browsers once a soft keyboard is
// involved, which is what was actually being asked for here. Buffers
// consecutive keystrokes (e.g. "k" "i" "n" -> "Kinematics") and resets the
// buffer after a short pause, same as native typeahead behaves.
let typeaheadBuffer = "";
let typeaheadLastKey = "";
let typeaheadTimer = null;
function typeaheadTextMatches(text, needle) {
    return text.includes(" " + needle) || text.startsWith(needle);
}
// Brief highlight flash so a typeahead jump reads as an intentional move
// rather than the value silently snapping — the select gets a short
// CSS transition (see .typeahead-jump in components.css) that clears
// itself automatically.
function flashTypeaheadJump(select) {
    select.classList.remove("typeahead-jump");
    // Force reflow so re-adding the class restarts the transition even if
    // the previous flash hasn't finished (fast repeated jumps).
    void select.offsetWidth;
    select.classList.add("typeahead-jump");
    clearTimeout(select._typeaheadFlashTimer);
    select._typeaheadFlashTimer = setTimeout(() => select.classList.remove("typeahead-jump"), 350);
}
function wireChapterTypeahead(select) {
    if (!select || select.dataset.typeaheadWired) return;
    select.dataset.typeaheadWired = "1";
    select.addEventListener("keydown", (e) => {
        if (e.key.length !== 1 || !/[a-z0-9]/i.test(e.key) || e.ctrlKey || e.metaKey || e.altKey) return;
        e.preventDefault();
        let key = e.key.toLowerCase();
        let options = Array.from(select.options);
        // Repeating the SAME single key (e.g. "w","w","w") cycles through
        // every match starting from the option after the current one —
        // matches native <select> typeahead. Typing a DIFFERENT key builds
        // a fresh prefix buffer ("k","i" -> "ki") like before.
        let isSameKeyRepeat = typeaheadLastKey === key && typeaheadBuffer.length > 0 && typeaheadBuffer.split("").every(c => c === key);
        typeaheadLastKey = key;
        clearTimeout(typeaheadTimer);
        typeaheadTimer = setTimeout(() => { typeaheadBuffer = ""; typeaheadLastKey = ""; }, 800);

        let match = null;
        if (isSameKeyRepeat) {
            typeaheadBuffer += key;
            let matches = options.filter(o => typeaheadTextMatches(o.textContent.toLowerCase(), key));
            if (matches.length) {
                let curIdx = matches.findIndex(o => o.value === select.value);
                match = matches[(curIdx + 1) % matches.length];
            }
        } else {
            typeaheadBuffer += key;
            match = options.find(o => typeaheadTextMatches(o.textContent.toLowerCase(), typeaheadBuffer));
            if (!match) {
                // No match for the full buffer (e.g. mistyped) — fall back to
                // just the newest keystroke, matching how native typeahead
                // recovers instead of getting stuck.
                typeaheadBuffer = key;
                match = options.find(o => typeaheadTextMatches(o.textContent.toLowerCase(), key));
            }
        }
        if (match && match.value !== select.value) {
            select.value = match.value;
            select.dispatchEvent(new Event("change"));
            flashTypeaheadJump(select);
        }
    });
}

function renderAddForm() {
    let subjects = Object.keys(SYLLABUS_SUBJECTS);
    if (!addFormChapter) {
        let firstList = [...(SYLLABUS_SUBJECTS[addFormSubject][11] || []), ...(SYLLABUS_SUBJECTS[addFormSubject][12] || [])];
        addFormChapter = firstList[0] || null;
    }
    let chapterOptions = [11, 12].flatMap(cls => (SYLLABUS_SUBJECTS[addFormSubject][cls] || []).map(ch => ({ cls, ch })));

    let key = addFormChapter ? keyFor(addFormSubject, addFormChapter) : null;
    let existingTotal = key && mistakeCache[key] ? totalCount(mistakeCache[key]) : 0;

    let html = `<div class="card" style="padding:12px;">
        <label style="font-size:12px; color:var(--muted);">Subject</label>
        <select id="mistake-add-subject" class="sort-select" style="width:100%; max-width:none;" onchange="onAddSubjectChange()">
            ${subjects.map(s => `<option value="${escapeHtml(s)}" ${s === addFormSubject ? 'selected' : ''}>${escapeHtml(s)}</option>`).join('')}
        </select>
        <label style="font-size:12px; color:var(--muted); margin-top:8px; display:block;">Chapter</label>
        <select id="mistake-add-chapter" class="sort-select" style="width:100%; max-width:none;" onchange="onAddChapterChange()" title="Tip: focus this and type a letter to jump to a chapter">
            ${chapterOptions.map(o => `<option value="${escapeHtml(o.ch)}" ${o.ch === addFormChapter ? 'selected' : ''}>Class ${o.cls} · ${escapeHtml(o.ch)}</option>`).join('')}
        </select>
        <div style="display:flex; align-items:center; gap:10px; margin-top:12px;">
            <span class="mc-name" style="flex:1;">${escapeHtml(addFormChapter || "—")}</span>
            <span class="mc-badge" style="color:var(--danger); border-color:var(--danger);" title="Already logged for this chapter">${existingTotal}</span>
        </div>
        <label style="font-size:12px; color:var(--muted); margin-top:8px; display:block;">Notes (required)</label>
        <textarea id="mistake-add-notes" class="mc-notes" placeholder="What went wrong, how to fix it..."></textarea>
        <label style="font-size:12px; color:var(--muted); margin-top:8px; display:block;">Attach files (optional)</label>
        <input type="file" id="mistake-add-files" accept="image/*,application/pdf" multiple>
        <button type="button" class="btn btn-start" style="width:100%; margin-top:12px;" onclick="saveAddMistake()">Log Mistake</button>
    </div>`;
    document.getElementById("mistake-add-wrap").innerHTML = html;
    wireChapterTypeahead(document.getElementById("mistake-add-chapter"));
}

function renderEntryBlock(subject, chapter, entry, isEditing, entryNumber) {
    let ek = entryKey(keyFor(subject, chapter), entry.id);
    let attachedElsewhere = entry.hasFiles && (!entry.files || entry.files.length === 0);
    let stamp = entry.createdAt ? new Date(entry.createdAt).toLocaleString() : "";

    if (!isEditing) {
        return `<div class="mc-entry-block" data-entry-id="${escapeHtml(String(entry.id))}">
            <div style="display:flex; align-items:center; justify-content:space-between; gap:8px;">
                <span class="mc-entry-meta">${entryNumber ? `<span class="mc-entry-num">#${entryNumber}</span> · ` : ''}${escapeHtml(stamp)}${entry.count > 1 ? ` · counted as ${entry.count}` : ''}</span>
                <div style="display:flex; gap:8px;">
                    <button type="button" class="mc-icon-btn" data-mc-edit-toggle title="Edit this entry">✏️</button>
                    <button type="button" class="mc-icon-btn" data-mc-delete-entry title="Delete this entry">🗑</button>
                </div>
            </div>
            <div class="mc-notes-view">${entry.notes ? escapeHtml(entry.notes) : '<span style="color:var(--muted);">No notes.</span>'}</div>
            ${((entry.files && entry.files.length) || attachedElsewhere) ? `<div class="mc-file-list">
                ${(entry.files || []).map(f => f.type.startsWith('image/')
                    ? `<span class="mc-file-chip"><a href="${f.dataUrl}" download="${escapeHtml(f.name)}" title="Download image"><img src="${f.dataUrl}"></a></span>`
                    : `<span class="mc-file-chip mc-file-pdf"><a href="${f.dataUrl}" download="${escapeHtml(f.name)}">📄 ${escapeHtml(f.name)}</a></span>`
                ).join('')}
                ${attachedElsewhere ? `<span class="small-note" style="font-style:italic;">📎 File Attached on another browser</span>` : ''}
            </div>` : ''}
        </div>`;
    }

    return `<div class="mc-entry-block" data-entry-id="${escapeHtml(String(entry.id))}">
        <div style="display:flex; align-items:center; justify-content:space-between; gap:8px;">
            <label style="font-size:12px; color:var(--muted); margin:0;">Count</label>
            <button type="button" class="mc-icon-btn" data-mc-edit-toggle title="Done editing">💾</button>
        </div>
        <input type="number" min="1" step="1" class="mc-count-input" value="${entry.count || 1}">
        <label style="font-size:12px; color:var(--muted);">Notes</label>
        <textarea class="mc-notes" placeholder="What went wrong, how to fix it...">${escapeHtml(entry.notes || "")}</textarea>
        <label style="font-size:12px; color:var(--muted);">Attach files (images / PDFs)</label>
        <div class="mc-files-row">
            <input type="file" id="${safeId(ek)}" accept="image/*,application/pdf" multiple>
            <button type="button" class="btn btn-start btn-small" data-mc-add-files>Add</button>
        </div>
        <div class="mc-file-list">
            ${(entry.files || []).map((f, i) => f.type.startsWith('image/')
                ? `<span class="mc-file-chip"><a href="${f.dataUrl}" download="${escapeHtml(f.name)}" title="Download image"><img src="${f.dataUrl}"></a><button type="button" data-mc-remove-file="${i}">✕</button></span>`
                : `<span class="mc-file-chip mc-file-pdf"><a href="${f.dataUrl}" download="${escapeHtml(f.name)}">📄 ${escapeHtml(f.name)}</a><button type="button" data-mc-remove-file="${i}">✕</button></span>`
            ).join('')}
            ${attachedElsewhere ? `<span class="small-note" style="font-style:italic;">📎 File Attached on another browser</span>` : ''}
        </div>
        <button type="button" class="btn btn-stop btn-small" style="margin-top:8px;" data-mc-delete-entry>Delete this entry</button>
    </div>`;
}

function renderViewList() {
    let subjects = Object.keys(SYLLABUS_SUBJECTS);
    document.getElementById("mistake-subject-tabs").innerHTML = subjects.map(s =>
        `<button class="${s === activeMistakeSubject ? 'active' : ''}" onclick="setMistakesSubject('${s}')">${escapeHtml(s)}</button>`
    ).join('');

    let allRecords = Object.values(mistakeCache);
    let grandTotal = allRecords.reduce((sum, r) => sum + totalCount(r), 0);
    let bySubject = {};
    allRecords.forEach(r => { bySubject[r.subject] = (bySubject[r.subject] || 0) + totalCount(r); });
    document.getElementById("mistake-overall").innerHTML =
        `<div>Total mistakes logged: <span class="highlight-text">${grandTotal}</span></div>
         <div class="small-note">This subject: <span class="highlight-text" style="font-size:12px;">${bySubject[activeMistakeSubject] || 0}</span></div>`;

    let rows = [];
    [11, 12].forEach(cls => {
        (SYLLABUS_SUBJECTS[activeMistakeSubject][cls] || []).forEach(ch => {
            if (mistakeSearchQuery && !ch.toLowerCase().includes(mistakeSearchQuery)) return;
            let key = keyFor(activeMistakeSubject, ch);
            rows.push({ cls, ch, record: mistakeCache[key] || blankRecord(activeMistakeSubject, ch) });
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
    rows.forEach(({ cls, ch, record }) => {
        if (showClassHeaders && cls !== lastCls) {
            html += `<div class="syllabus-class-header">Class ${cls}</div>`;
            lastCls = cls;
        }
        let key = keyFor(activeMistakeSubject, ch);
        let isExpanded = !!expandedMistakeChapters[key];
        let entries = (record.entries || []).slice().sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));

        html += `<div class="mistake-chapter-card ${isExpanded ? 'expanded' : ''}" data-subject="${escapeHtml(activeMistakeSubject)}" data-chapter="${escapeHtml(ch)}">
            <div class="mc-top">
                <span class="mc-name">${escapeHtml(ch)}</span>
                <span class="mc-badge" style="color:var(--danger); border-color:var(--danger);">${totalCount(record)}</span>
            </div>`;

        if (isExpanded) {
            html += `<div class="mc-detail">`;
            if (entries.length === 0) {
                html += `<span class="small-note">No mistakes logged for this chapter yet.</span>`;
            } else {
                entries.forEach((entry, idx) => {
                    let isEditing = !!editingEntries[entryKey(key, entry.id)];
                    html += renderEntryBlock(activeMistakeSubject, ch, entry, isEditing, idx + 1);
                });
                html += `<button type="button" class="btn btn-stop btn-small" data-mc-delete-log>Clear ALL entries for this chapter</button>`;
            }
            html += `</div>`;
        }
        html += `</div>`;
    });
    document.getElementById("mistake-chapter-list").innerHTML = html || `<div class="small-note" style="margin-top:10px;">No chapters match.</div>`;
}

export async function renderMistakesTracker() {
    wireDelegationOnce();
    let list = await getAllMistakeChapters();
    mistakeCache = {};
    list.forEach(rec => { let normalized = normalizeRecord(rec); if (normalized) mistakeCache[normalized.key] = normalized; });

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

// Renames an attachment for the flattened per-chapter export below: e.g.
// "Mock Test 3.pdf" logged as this chapter's 2nd mistake becomes
// "Mock Test 3 (Mistake 2).pdf" — keeps the original filename recognizable
// while making clear which mistake entry it belongs to now that there's no
// per-mistake subfolder. When one entry has more than one attachment, a
// "-N" file index is appended too (Mistake 2-1, Mistake 2-2, ...) so two
// same-named files from the same entry (e.g. two screenshots both named
// "image.png") don't collide and overwrite each other in the zip.
function tagFileName(name, mistakeNum, fileIdx, fileCount) {
    let dot = name.lastIndexOf(".");
    let base = dot > 0 ? name.slice(0, dot) : name;
    let ext = dot > 0 ? name.slice(dot) : "";
    let tag = fileCount > 1 ? `Mistake ${mistakeNum}-${fileIdx + 1}` : `Mistake ${mistakeNum}`;
    return `${base} (${tag})${ext}`;
}

// Bundles every logged mistake, across every subject and chapter, into one
// .zip: a top-level Mistakes-Summary.md overview (grouped by subject >
// chapter, same order as the on-screen tabs) for quick browsing, PLUS a
// flat Subject/Chapter/ folder holding every entry's own notes file and
// attachments side by side — no per-mistake subfolder — so opening one
// chapter's folder shows everything at once instead of clicking into a
// separate folder per mistake. Each entry's notes file and attachments are
// disambiguated by "Mistake N" in their filenames instead of a folder each.
export async function exportAllMistakes() {
    let records = await getAllMistakeChapters();
    let totalEntries = records.reduce((sum, r) => sum + ((r.entries || []).length), 0);
    if (totalEntries === 0) { alert("No mistake entries to export yet."); return; }
    if (typeof JSZip === "undefined") { alert("The export library didn't load — check your connection and try again."); return; }

    let bySubject = {};
    records.forEach(r => {
        if (!r.entries || r.entries.length === 0) return;
        if (!bySubject[r.subject]) bySubject[r.subject] = [];
        bySubject[r.subject].push(r);
    });

    let zip = new JSZip();
    let lines = [`# Mistake Entries`, `Exported ${new Date().toLocaleString()} · ${totalEntries} entr${totalEntries === 1 ? 'y' : 'ies'} total`, ""];

    Object.keys(SYLLABUS_SUBJECTS).forEach(subject => {
        let chapterRecords = bySubject[subject];
        if (!chapterRecords || chapterRecords.length === 0) return;
        let subjectTotal = chapterRecords.reduce((sum, r) => sum + r.entries.length, 0);
        lines.push(`# ${subject} (${subjectTotal} mistakes)`, "");

        chapterRecords.forEach(rec => {
            let sortedEntries = rec.entries.slice().sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
            lines.push(`## ${rec.chapter} (${sortedEntries.length})`, "");
            let safeChapter = rec.chapter.replace(/[\\/:*?"<>|]/g, "_");
            // Flat per-chapter folder — no per-mistake subfolder. Every
            // entry's notes file and attachments live side by side directly
            // in Subject/Chapter/, disambiguated by "Mistake N" in their
            // filenames instead of a folder each (see tagFileName above).
            let chapterFolder = `${subject}/${safeChapter}`;

            sortedEntries.forEach((entry, idx) => {
                let num = idx + 1;
                let stamp = entry.createdAt ? new Date(entry.createdAt).toLocaleString() : "";
                lines.push(`**#${num} · ${stamp}${entry.count > 1 ? ` · counted as ${entry.count}` : ''}**`);
                lines.push("");
                lines.push(entry.notes ? entry.notes : "_(no notes)_");

                let entryNoteLines = [
                    `# ${subject} · ${rec.chapter} · Mistake ${num}`,
                    stamp ? `Logged: ${stamp}` : "",
                    entry.count > 1 ? `Counted as: ${entry.count}` : "",
                    "",
                    entry.notes ? entry.notes : "_(no notes)_"
                ].filter(l => l !== "");
                zip.file(`${chapterFolder}/Mistake ${num} - Notes.md`, entryNoteLines.join("\n"));

                if (entry.files && entry.files.length) {
                    lines.push("");
                    lines.push(`Attachments: ${entry.files.map(f => f.name).join(", ")}`);
                    entry.files.forEach((f, fi) => {
                        let base64 = (f.dataUrl || "").split(",")[1];
                        if (base64) zip.file(`${chapterFolder}/${tagFileName(f.name, num, fi, entry.files.length)}`, base64, { base64: true });
                    });
                } else if (entry.hasFiles) {
                    lines.push("");
                    lines.push("_(attachment saved on another browser — not included here)_");
                }
                lines.push("", "---", "");
            });
        });
    });

    zip.file("Mistakes-Summary.md", lines.join("\n"));
    let blob = await zip.generateAsync({ type: "blob" });
    downloadBlob(blob, `JEE-Tracker-Mistakes-${getTodayKey()}.zip`, "application/zip");
}
