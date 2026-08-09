import { escapeHtml, fileToDataURL } from './utils.js';
import { getAllMistakeChapters, getMistakeEntry, saveMistakeEntry } from './storage.js';
import { SYLLABUS_SUBJECTS } from './syllabus.js';
// Forward reference — ui.js lands in Step 7. Only called inside function
// bodies, safe once the full module graph is wired in main.js.
import { showToast } from './ui.js';

let activeMistakeSubject = "Physics";
let expandedMistakeChapters = {};
// Cache of key -> entry, refreshed at the start of every render so the
// synchronous HTML-building pass below doesn't need to be async itself.
let mistakeCache = {};

function keyFor(subject, chapter) { return subject + "|" + chapter; }
// DOM ids can't contain the characters chapter/subject names sometimes
// have (spaces, parens, /, etc.) — build a safe id from the key.
function safeId(key) { return "mistake-file-" + key.replace(/[^a-zA-Z0-9]/g, "_"); }

function blankEntry(subject, chapter) {
    return { key: keyFor(subject, chapter), subject, chapter, count: 0, notes: "", files: [], hasFiles: false };
}

export function setMistakesSubject(subject) {
    activeMistakeSubject = subject;
    renderMistakesTracker();
}

export function toggleMistakeChapterExpand(subject, chapter) {
    let key = keyFor(subject, chapter);
    expandedMistakeChapters[key] = !expandedMistakeChapters[key];
    renderMistakesTracker();
}

export async function updateMistakeCount(subject, chapter, value) {
    let key = keyFor(subject, chapter);
    let entry = mistakeCache[key] || blankEntry(subject, chapter);
    let n = parseInt(value, 10);
    entry.count = (isNaN(n) || n < 0) ? 0 : n;
    await saveMistakeEntry(entry);
    mistakeCache[key] = entry;
    renderMistakesTracker();
}

export async function saveMistakeNotes(subject, chapter, value) {
    let key = keyFor(subject, chapter);
    let entry = mistakeCache[key] || blankEntry(subject, chapter);
    entry.notes = value;
    await saveMistakeEntry(entry);
    mistakeCache[key] = entry;
    // No re-render needed — avoids yanking focus out of the textarea the
    // user is still typing in (onchange only fires when they leave it).
}

export async function addMistakeFiles(subject, chapter) {
    let key = keyFor(subject, chapter);
    let input = document.getElementById(safeId(key));
    if (!input || !input.files || input.files.length === 0) return;
    let entry = mistakeCache[key] || blankEntry(subject, chapter);
    if (!entry.files) entry.files = [];
    for (let f of input.files) entry.files.push(await fileToDataURL(f));
    entry.hasFiles = entry.files.length > 0;
    await saveMistakeEntry(entry);
    mistakeCache[key] = entry;
    input.value = "";
    showToast("Attachment added.");
    renderMistakesTracker();
}

export async function removeMistakeFile(subject, chapter, idx) {
    let key = keyFor(subject, chapter);
    let entry = mistakeCache[key];
    if (!entry) return;
    // Same cross-device guard as mock tests: if the cloud says this chapter
    // has attachments but this browser's IndexedDB doesn't actually hold
    // them (attached on a different device — file bytes never sync), there
    // is nothing local to remove.
    if (entry.hasFiles && (!entry.files || entry.files.length === 0)) {
        alert("This chapter has an attachment on a different browser/device (not this one). Remove it from the browser where the file actually is.");
        return;
    }
    if (!confirm("Remove this attachment?")) return;
    entry.files.splice(idx, 1);
    entry.hasFiles = entry.files.length > 0;
    await saveMistakeEntry(entry);
    mistakeCache[key] = entry;
    renderMistakesTracker();
}

export async function renderMistakesTracker() {
    let list = await getAllMistakeChapters();
    mistakeCache = {};
    list.forEach(e => { mistakeCache[e.key] = e; });

    let subjects = Object.keys(SYLLABUS_SUBJECTS);
    document.getElementById("mistake-subject-tabs").innerHTML = subjects.map(s =>
        `<button class="${s === activeMistakeSubject ? 'active' : ''}" onclick="setMistakesSubject('${s.replace(/'/g,"\\'")}')">${escapeHtml(s)}</button>`
    ).join('');

    let totalMistakes = 0;
    list.forEach(e => { totalMistakes += (e.count || 0); });
    document.getElementById("mistake-overall").innerHTML = `<div>Total mistakes logged: <span class="highlight-text">${totalMistakes}</span></div>`;

    let html = "";
    [11, 12].forEach(cls => {
        let chapters = SYLLABUS_SUBJECTS[activeMistakeSubject][cls] || [];
        if (chapters.length === 0) return;
        html += `<div class="syllabus-class-header">Class ${cls}</div>`;
        chapters.forEach(ch => {
            let key = keyFor(activeMistakeSubject, ch);
            let entry = mistakeCache[key] || blankEntry(activeMistakeSubject, ch);
            let isExpanded = !!expandedMistakeChapters[key];
            let attachedElsewhere = entry.hasFiles && (!entry.files || entry.files.length === 0);
            let subjEsc = activeMistakeSubject.replace(/'/g, "\\'");
            let chEsc = ch.replace(/'/g, "\\'");

            html += `<div class="mistake-chapter-card ${isExpanded ? 'expanded' : ''}">
                <div class="mc-top" onclick="toggleMistakeChapterExpand('${subjEsc}','${chEsc}')">
                    <span class="mc-name">${escapeHtml(ch)}</span>
                    <span class="mc-badge">${entry.count || 0} mistake${entry.count === 1 ? '' : 's'}</span>
                </div>`;

            if (isExpanded) {
                html += `<div class="mc-detail" onclick="event.stopPropagation()">
                    <label style="font-size:12px; color:var(--muted);">Mistakes made</label>
                    <input type="number" min="0" step="1" class="mc-count-input" value="${entry.count || 0}"
                        onchange="updateMistakeCount('${subjEsc}','${chEsc}', this.value)">
                    <label style="font-size:12px; color:var(--muted);">Notes</label>
                    <textarea class="mc-notes" placeholder="What went wrong, how to fix it..."
                        onchange="saveMistakeNotes('${subjEsc}','${chEsc}', this.value)">${escapeHtml(entry.notes || "")}</textarea>
                    <label style="font-size:12px; color:var(--muted);">Attach files (images / PDFs)</label>
                    <div class="mc-files-row">
                        <input type="file" id="${safeId(key)}" accept="image/*,application/pdf" multiple>
                        <button type="button" class="btn btn-start btn-small" onclick="addMistakeFiles('${subjEsc}','${chEsc}')">Add</button>
                    </div>
                    <div class="mc-file-list">
                        ${(entry.files || []).map((f, i) => f.type.startsWith('image/')
                            ? `<span class="mc-file-chip"><img src="${f.dataUrl}"><button type="button" onclick="removeMistakeFile('${subjEsc}','${chEsc}',${i})">✕</button></span>`
                            : `<span class="mc-file-chip mc-file-pdf"><a href="${f.dataUrl}" download="${escapeHtml(f.name)}">📄 ${escapeHtml(f.name)}</a><button type="button" onclick="removeMistakeFile('${subjEsc}','${chEsc}',${i})">✕</button></span>`
                        ).join('')}
                        ${attachedElsewhere ? `<span class="small-note" style="font-style:italic;">📎 Attached on another browser</span>` : ''}
                    </div>
                </div>`;
            }
            html += `</div>`;
        });
    });
    document.getElementById("mistake-chapter-list").innerHTML = html;
}
