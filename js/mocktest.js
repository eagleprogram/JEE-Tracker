import { escapeHtml, fileToDataURL, getTodayKey, formatDateDDMMYYYY, downloadBlob } from './utils.js';
import { openMockDB, getAllMockTests, MOCK_STORE } from './storage.js';
// Forward reference — ui.js lands in Step 7. Only called inside function
// bodies, safe once the full module graph is wired in main.js.
import { showToast } from './ui.js';

export const MISTAKE_TAGS = ["Silly mistake", "Concept gap", "Time pressure", "Calculation error", "Misread question", "Not revised", "Panic/anxiety", "Guessed wrong", "Other"];
let selectedMistakeTags = [];

export function renderMistakeTagPicker() {
    let wrap = document.getElementById("mistake-tag-picker");
    if (!wrap) return;
    wrap.innerHTML = MISTAKE_TAGS.map(t => `<span class="mistake-tag-chip ${selectedMistakeTags.includes(t) ? 'selected' : ''}" onclick="toggleMistakeTag('${t.replace(/'/g, "\\'")}')">${t}</span>`).join('');
}

export function toggleMistakeTag(tag) {
    if (selectedMistakeTags.includes(tag)) selectedMistakeTags = selectedMistakeTags.filter(t => t !== tag);
    else selectedMistakeTags.push(tag);
    renderMistakeTagPicker();
}

export function renderMistakeSummary(entries) {
    let summaryEl = document.getElementById("mistake-tag-summary");
    if (!summaryEl) return;
    // With zero mock tests at all, "No mock tests logged yet." (rendered by
    // renderMockTestList below) already says everything — showing "No
    // mistake tags logged yet." right above it was redundant (there can't
    // be tags without tests). Only show this line once there's at least one
    // test but it/they carry no tags yet.
    if (entries.length === 0) { summaryEl.innerHTML = ""; return; }
    let counts = {};
    entries.forEach(e => (e.mistakeTags || []).forEach(t => { counts[t] = (counts[t] || 0) + 1; }));
    let tags = Object.keys(counts).sort((a, b) => counts[b] - counts[a]);
    if (tags.length === 0) { summaryEl.innerHTML = `<span class="small-note">No mistake tags logged yet.</span>`; return; }
    summaryEl.innerHTML = tags.map(t => `<span class="ms-pill">${escapeHtml(t)}: ${counts[t]}</span>`).join('');
}

// Score % used by the score-based sort options. Every saved entry always
// has a valid numeric score/maxScore (enforced in addMockTestEntry), so no
// null-handling needed here.
function scorePct(e) {
    let s = parseFloat(e.score), m = parseFloat(e.maxScore);
    return (m > 0) ? (s / m) * 100 : 0;
}

function sortMockEntries(entries, mode) {
    let arr = entries.slice();
    switch (mode) {
        case "added-asc": arr.sort((a, b) => a.id - b.id); break;
        case "date-desc": arr.sort((a, b) => b.date.localeCompare(a.date) || b.id - a.id); break;
        case "date-asc": arr.sort((a, b) => a.date.localeCompare(b.date) || b.id - a.id); break;
        case "score-desc": arr.sort((a, b) => scorePct(b) - scorePct(a)); break;
        case "score-asc": arr.sort((a, b) => scorePct(a) - scorePct(b)); break;
        case "mistakes-desc": arr.sort((a, b) => (b.mistakeTags || []).length - (a.mistakeTags || []).length); break;
        case "mistakes-asc": arr.sort((a, b) => (a.mistakeTags || []).length - (b.mistakeTags || []).length); break;
        case "added-desc":
        default: arr.sort((a, b) => b.id - a.id); break;
    }
    return arr;
}

export async function addMockTestEntry() {
    let date = document.getElementById("mock-date-input").value;
    let subject = document.getElementById("mock-subject-input").value.trim();
    let score = document.getElementById("mock-score-input").value.trim();
    let maxScore = document.getElementById("mock-maxscore-input").value.trim();
    let notes = document.getElementById("mock-notes-input").value.trim();
    let filesInput = document.getElementById("mock-files-input");

    // Require date, subject, and both marks fields before saving — a
    // half-filled entry (e.g. no score yet) used to be allowed through,
    // making the mock-test log unreliable to trust for averages/trends.
    if (!date) { alert("Pick a date for this mock test first."); return; }
    if (date > getTodayKey()) { alert("The date can't be in the future — pick today or an earlier date."); return; }
    if (!subject) { alert("Enter the exam/subject name first."); return; }
    if (!score) { alert("Enter your score first."); return; }
    if (!maxScore) { alert("Enter the maximum possible score (\"Out of\") first."); return; }
    let sNum = parseFloat(score), mNum = parseFloat(maxScore);
    if (isNaN(sNum) || isNaN(mNum)) { alert("Score and Out of must be numbers."); return; }
    if (sNum > mNum) { alert(`Score (${score}) can't be greater than Out of (${maxScore}) — please check the values.`); return; }

    let files = []; for (let f of filesInput.files) files.push(await fileToDataURL(f));
    // hasFiles is synced to the cloud even though the actual file bytes
    // never are (see firebase-sync.js) — it's how a browser that only has
    // the metadata (pulled from another device) knows an attachment exists
    // elsewhere and shouldn't be silently treated as if it has none.
    let entry = { id: Date.now(), date, subject, score, maxScore, notes, files, hasFiles: files.length > 0, mistakeTags: [...selectedMistakeTags] };
    let db = await openMockDB();
    let tx = db.transaction(MOCK_STORE, "readwrite");
    tx.objectStore(MOCK_STORE).add(entry);
    tx.oncomplete = () => {
        showToast("Mock test entry saved.");
        document.getElementById("mock-subject-input").value = "";
        document.getElementById("mock-score-input").value = "";
        document.getElementById("mock-maxscore-input").value = "";
        document.getElementById("mock-notes-input").value = "";
        filesInput.value = "";
        selectedMistakeTags = [];
        renderMistakeTagPicker();
        renderMockTestList();
    };
}

export async function deleteMockTestEntry(id) {
    let entries = await getAllMockTests();
    let entry = entries.find(e => e.id === id);
    // If the cloud says this entry has an attachment (hasFiles) but this
    // browser's IndexedDB doesn't actually hold the file (it was attached
    // on a different device — file bytes never sync), block the delete
    // here. Deleting would still remove the entry locally, and the next
    // sync push from THIS browser would wipe the entry from the cloud too
    // — silently destroying the only copy's record, since the browser that
    // actually holds the file might not push again for hours.
    if (entry && entry.hasFiles && (!entry.files || entry.files.length === 0)) {
        alert("This mock test has a file attached on a different browser/device (not this one). To avoid losing that attachment, delete it from the browser where the file actually is.");
        return;
    }
    if (!confirm("Delete this mock test entry and its attachments?")) return;
    let db = await openMockDB();
    let tx = db.transaction(MOCK_STORE, "readwrite");
    tx.objectStore(MOCK_STORE).delete(id);
    tx.oncomplete = () => renderMockTestList();
}

export async function renderMockTestList() {
    let list = document.getElementById("mock-test-list");
    let entries = await getAllMockTests(); // already sorted newest-added-first (id = Date.now() at creation)
    renderMistakeSummary(entries);
    // No margin-top here — .sidebar-content's flex `gap` already spaces this
    // from the section above; adding one on top of that (and on top of
    // #mistake-tag-summary's own margin, even while empty) is what was
    // compounding into the large gap above this message when there were 0
    // mock tests logged.
    if (entries.length === 0) { list.innerHTML = "<div class='small-note'>No mock tests logged yet.</div>"; return; }

    let avg = 0, count = 0;
    entries.forEach(e => {
        if (e.score && e.maxScore && parseFloat(e.maxScore) > 0) {
            let pct = (parseFloat(e.score) / parseFloat(e.maxScore)) * 100;
            avg += pct; count++;
        }
    });
    document.getElementById("mock-avg-score").innerText = count > 0 ? Math.round(avg/count) + "%" : "0%";
    document.getElementById("mock-total-count").innerText = entries.length;

    let sortSelect = document.getElementById("mock-sort-select");
    let sortedEntries = sortMockEntries(entries, sortSelect ? sortSelect.value : "added-desc");

    let html = "";
    sortedEntries.forEach(e => {
        let attachedElsewhere = e.hasFiles && (!e.files || e.files.length === 0);
        html += `<div class="mock-entry"><div class="mock-top"><div class="mock-title-wrap"><strong class="mock-title" title="${escapeHtml(e.subject)}">${escapeHtml(e.subject)}</strong><div class="small-note" style="margin:0;">${formatDateDDMMYYYY(e.date)}</div></div><div class="mock-score-wrap"><span class="mock-score">${e.score || '—'}${e.maxScore ? ' / ' + e.maxScore : ''}</span><button class="del" onclick="deleteMockTestEntry(${e.id})">✕</button></div></div>${e.notes ? `<div style="font-size:13px; margin-top:8px; white-space:pre-wrap;">${escapeHtml(e.notes)}</div>` : ''}${(e.mistakeTags && e.mistakeTags.length) ? `<div class="entry-tags">${e.mistakeTags.map(t => `<span>${escapeHtml(t)}</span>`).join('')}</div>` : ''}<div class="mock-files">${(e.files||[]).map((f, i) => f.type.startsWith('image/') ? `<img src="${f.dataUrl}" onclick="viewMockFile(${e.id},${i})">` : `<a class="pdf-chip" href="${f.dataUrl}" download="${f.name}">📄 ${escapeHtml(f.name)}</a>`).join('')}${attachedElsewhere ? `<span class="small-note" style="font-style:italic;">📎 File Attached on another browser</span>` : ''}</div></div>`;
    });
    list.innerHTML = html + `<div style="height:40px;"></div>`; // Add bottom padding
}

// Holds the file currently shown in the preview modal so the modal's
// Download button knows what to save — set on open, cleared on close.
let currentModalFile = null;

export async function viewMockFile(entryId, fileIdx) {
    let entries = await getAllMockTests();
    let entry = entries.find(e => e.id === entryId);
    if (!entry) return;
    let f = entry.files[fileIdx];
    currentModalFile = f;
    document.getElementById("mock-file-modal-body").innerHTML = `<img src="${f.dataUrl}" style="max-width:100%; border-radius:8px;">`;
    document.getElementById("mock-file-modal").style.display = "flex";
}

export function closeMockFileModal() {
    document.getElementById("mock-file-modal").style.display = "none";
    currentModalFile = null;
}

// Renames an attachment for the flat export below — same pattern as
// mistakes.js's tagFileName: "scan.jpg" attached to mock test #3 becomes
// "scan (Mock 3).jpg", disambiguated with a "-N" file index if that entry
// has more than one attachment (Mock 3-1, Mock 3-2, ...) so same-named
// files from one entry don't overwrite each other in the zip.
function tagFileName(name, entryNum, fileIdx, fileCount) {
    let dot = name.lastIndexOf(".");
    let base = dot > 0 ? name.slice(0, dot) : name;
    let ext = dot > 0 ? name.slice(dot) : "";
    let tag = fileCount > 1 ? `Mock ${entryNum}-${fileIdx + 1}` : `Mock ${entryNum}`;
    return `${base} (${tag})${ext}`;
}

// Bundles every mock-test entry into one .zip: a top-level Mock-Tests-
// Summary.md overview (score, tags, notes, in order) for quick browsing,
// PLUS every entry's own notes file and attachments sitting flat at the
// zip root — no per-entry folder — disambiguated by "N. Subject (date)"
// in the notes filename and "(Mock N)" tagged onto each attachment's own
// name, so each test's notes stay identifiable next to its files without
// a folder each. Uses JSZip (loaded via CDN in index.html) since browsers
// can't build a real zip archive on their own — only one file per click
// without it.
export async function exportAllMockTests() {
    let entries = await getAllMockTests();
    if (entries.length === 0) { alert("No mock test entries to export yet."); return; }
    if (typeof JSZip === "undefined") { alert("The export library didn't load — check your connection and try again."); return; }

    let sorted = entries.slice().sort((a, b) => (a.date || "").localeCompare(b.date || "") || a.id - b.id);
    let zip = new JSZip();
    let lines = [`# Mock Test Entries`, `Exported ${new Date().toLocaleString()} · ${sorted.length} entr${sorted.length === 1 ? 'y' : 'ies'}`, ""];

    sorted.forEach((e, idx) => {
        let num = idx + 1;
        let safeName = `${num}. ${(e.subject || "Untitled").replace(/[\\/:*?"<>|]/g, "_")} (${formatDateDDMMYYYY(e.date)})`;
        lines.push(`## #${num} · ${e.subject || "Untitled"} · ${formatDateDDMMYYYY(e.date)}`);
        lines.push(`Score: ${e.score || "—"}${e.maxScore ? " / " + e.maxScore : ""}`);
        if (e.mistakeTags && e.mistakeTags.length) lines.push(`Mistake tags: ${e.mistakeTags.join(", ")}`);
        lines.push("");
        lines.push(e.notes ? e.notes : "_(no notes)_");

        let entryNoteLines = [
            `# ${e.subject || "Untitled"} · ${formatDateDDMMYYYY(e.date)}`,
            `Score: ${e.score || "—"}${e.maxScore ? " / " + e.maxScore : ""}`,
            (e.mistakeTags && e.mistakeTags.length) ? `Mistake tags: ${e.mistakeTags.join(", ")}` : "",
            "",
            e.notes ? e.notes : "_(no notes)_"
        ].filter(l => l !== "");
        zip.file(`${safeName} - Notes.md`, entryNoteLines.join("\n"));

        if (e.files && e.files.length) {
            lines.push("");
            lines.push(`Attachments: ${e.files.map(f => f.name).join(", ")}`);
            e.files.forEach((f, fi) => {
                let base64 = (f.dataUrl || "").split(",")[1];
                if (base64) zip.file(tagFileName(f.name, num, fi, e.files.length), base64, { base64: true });
            });
        } else if (e.hasFiles) {
            lines.push("");
            lines.push("_(attachment saved on another browser — not included here)_");
        }
        lines.push("", "---", "");
    });

    zip.file("Mock-Tests-Summary.md", lines.join("\n"));
    let blob = await zip.generateAsync({ type: "blob" });
    downloadBlob(blob, `JEE-Tracker-MockTests-${getTodayKey()}.zip`, "application/zip");
}

// Images in the mock-test attachment strip open this preview modal instead
// of downloading directly on click (so tapping one to look at it doesn't
// immediately dump a file), so the download action lives here instead.
export function downloadCurrentMockFile() {
    if (!currentModalFile) return;
    let a = document.createElement("a");
    a.href = currentModalFile.dataUrl;
    a.download = currentModalFile.name || "attachment";
    document.body.appendChild(a);
    a.click();
    a.remove();
}
