import { formatReadable, formatTime12Hour, timeToMinutes, getTodayKey, escapeHtml, formatDateDDMMYYYY, generateId } from './utils.js';
import { getDB, saveDB, ensureDayShape, blankDay, getSleepLog } from './storage.js';
import { updateLiveSummary, resetOpenEntryRefs } from './timer.js';
import { renderGarden, renderHeatmap, renderTrendChart } from './charts.js';

// Missed-break start/end times should only be loggable within the day's
// actual awake window: no earlier than that date's logged wake time (a
// break can't happen before you woke up), and — only when the selected
// date IS today, since "now" has no meaning for a past date — no later
// than the current time (a break can't be logged before it's happened).
// Applied as native <input type="time"> min/max so the browser's own time
// picker enforces it, not just a post-submit alert.
export function applyMissedBreakTimeConstraints(dt) {
    let startEl = document.getElementById("missed-break-start");
    let endEl = document.getElementById("missed-break-end");
    if (!startEl || !endEl) return;

    let wakeTime = getSleepLog()[dt]?.wakeTime || null;
    [startEl, endEl].forEach(el => {
        if (wakeTime) el.setAttribute("min", wakeTime); else el.removeAttribute("min");
    });

    if (dt === getTodayKey()) {
        let now = new Date();
        let nowHHMM = String(now.getHours()).padStart(2, "0") + ":" + String(now.getMinutes()).padStart(2, "0");
        [startEl, endEl].forEach(el => el.setAttribute("max", nowHHMM));
    } else {
        [startEl, endEl].forEach(el => el.removeAttribute("max"));
    }
}

// Re-reads whatever date is currently selected in the history picker and
// re-applies the constraint above — called after saving a sleep log (see
// sleep.js) so a just-logged wake time takes effect immediately even if
// the user never touches the history date picker itself.
export function refreshMissedBreakConstraints() {
    let dt = document.getElementById("history-picker")?.value;
    if (dt) applyMissedBreakTimeConstraints(dt);
}

export function loadHistoryData() {
    let dt = document.getElementById("history-picker").value;
    if (!dt) return;
    applyMissedBreakTimeConstraints(dt);
    let db = getDB();
    let day = db[dt];
    if (!day) {
        document.getElementById("history-subject-list").innerHTML = "<em>No data recorded.</em>";
        document.getElementById("history-break-list").innerHTML = "<em>No break logs recorded.</em>";
        document.getElementById("history-session-list").innerHTML = "<em>No sessions recorded.</em>";
        return;
    }
    ensureDayShape(day);
    let sHtml = `<div style="margin-bottom:12px; padding:10px 14px; border:1px solid var(--border); border-radius:8px; display:inline-flex; gap:16px; flex-wrap:wrap;"><span><strong>Total Study:</strong> <span style="color:#a78bfa;">${formatReadable(day.totalStudy)}</span></span><span style="color:var(--muted);">&amp;</span><span><strong>Total Break:</strong> <span style="color:#a78bfa;">${formatReadable(day.totalBreak)}</span></span></div>`;
    for (let [cat, sec] of Object.entries(day.subjects)) {
        sHtml += `<div class="stat-row"><span>${cat}:</span><span style="display:flex; align-items:center; gap:8px;"><strong>${formatReadable(sec)}</strong><button class="del" onclick="deleteSubjectEntry('${dt}','${cat}')">✕</button></span></div>`;
    }
    document.getElementById("history-subject-list").innerHTML = sHtml;

    // Sort breaks: earliest to latest
    if (day.breaks && day.breaks.length > 1) {
        day.breaks.sort((a, b) => timeToMinutes(a.time) - timeToMinutes(b.time));
    }
    saveDB(db); // breaks saved here

    let bHtml = "";
    if (!day.breaks || day.breaks.length === 0) bHtml = "<em>No break logs recorded.</em>";
    else { day.breaks.forEach((b) => { bHtml += `<div class="stat-row"><span><strong>[${formatTime12Hour(b.time)}]</strong> ${escapeHtml(b.reason)}</span><span style="display:flex; align-items:center; gap:8px;"><span style="color:#a78bfa;">${formatReadable(b.duration)}</span><button class="del" onclick="deleteBreakEntry('${dt}','${b.id}')">✕</button></span></div>`; }); }
    document.getElementById("history-break-list").innerHTML = bHtml;

    // Sort sessions: earliest to latest
    if (day.studySessions && day.studySessions.length > 1) {
        day.studySessions.sort((a, b) => timeToMinutes(a.time) - timeToMinutes(b.time));
    }
    saveDB(db); // study sessions saved here

    let sessHtml = "";
    if (!day.studySessions || day.studySessions.length === 0) sessHtml = "<em>No individual sessions recorded.</em>";
    else { day.studySessions.forEach((s) => { sessHtml += `<div class="session-log-item"><span><strong>[${formatTime12Hour(s.time)}]</strong> ${s.subject}</span><span style="display:flex; align-items:center; gap:8px;"><span style="color:var(--success);">${formatReadable(s.duration)}</span><button class="del" onclick="deleteStudySessionEntry('${dt}','${s.id}')">✕</button></span></div>`; }); }
    document.getElementById("history-session-list").innerHTML = sessHtml;
}

export function deleteSubjectEntry(dt, subject) {
    let db = getDB(); if (!db[dt]) return;
    let sec = db[dt].subjects[subject] || 0; if (sec <= 0) { alert("No time logged."); return; }
    if (!confirm(`Delete ${formatReadable(sec)} logged for ${subject} on ${formatDateDDMMYYYY(dt)}?`)) return;
    db[dt].totalStudy = Math.max(0, db[dt].totalStudy - sec);
    db[dt].subjects[subject] = 0; if (db[dt].studySessions) db[dt].studySessions = db[dt].studySessions.filter(s => s.subject !== subject);
    saveDB(db); loadHistoryData(); if (dt === getTodayKey()) updateLiveSummary(); renderGarden(); renderHeatmap(); renderTrendChart();
}

export function deleteStudySessionEntry(dt, id) {
    let db = getDB(); if (!db[dt] || !db[dt].studySessions) return;
    let idx = db[dt].studySessions.findIndex(s => s.id === id);
    if (idx < 0) return;
    let entry = db[dt].studySessions[idx];
    if (!confirm(`Delete this one ${formatReadable(entry.duration)} session?`)) return;
    db[dt].totalStudy = Math.max(0, db[dt].totalStudy - entry.duration);
    db[dt].subjects[entry.subject] = Math.max(0, (db[dt].subjects[entry.subject] || 0) - entry.duration);
    db[dt].studySessions.splice(idx, 1); resetOpenEntryRefs();
    saveDB(db); loadHistoryData(); if (dt === getTodayKey()) updateLiveSummary(); renderGarden(); renderHeatmap(); renderTrendChart();
}

export function deleteBreakEntry(dt, id) {
    let db = getDB(); if (!db[dt] || !db[dt].breaks) return;
    let idx = db[dt].breaks.findIndex(b => b.id === id);
    if (idx < 0) return;
    let entry = db[dt].breaks[idx];
    if (!confirm(`Delete this ${formatReadable(entry.duration)} break?`)) return;
    db[dt].totalBreak = Math.max(0, db[dt].totalBreak - entry.duration);
    db[dt].breaks.splice(idx, 1); resetOpenEntryRefs();
    saveDB(db); loadHistoryData(); if (dt === getTodayKey()) updateLiveSummary(); renderGarden(); renderHeatmap(); renderTrendChart();
}

export function deleteStudyLog() {
    let dt = document.getElementById("history-picker").value; if (!dt) return;
    let db = getDB(); if (!db[dt]) { alert("No data."); return; }
    if (!confirm(`Delete all study logs for ${formatDateDDMMYYYY(dt)}?`)) return;
    db[dt].subjects = { ...blankDay().subjects };
    db[dt].totalStudy = 0; db[dt].studySessions = [];
    saveDB(db); loadHistoryData(); if (dt === getTodayKey()) updateLiveSummary(); renderGarden(); renderHeatmap(); renderTrendChart();
}

// Manually add a break entry for a time range that was never tracked live
// (e.g. logged after the fact from memory). Same shape/consequences as a
// break the timer commits itself: pushed into day.breaks, added to
// day.totalBreak, sorted into place next render by loadHistoryData()'s
// existing timeToMinutes sort. Always applies to whatever date is selected
// in #history-picker, not necessarily today.
export function addMissedBreak() {
    let dt = document.getElementById("history-picker").value;
    if (!dt) { alert("Pick a date first."); return; }

    let reasonEl = document.getElementById("missed-break-reason");
    let startEl = document.getElementById("missed-break-start");
    let endEl = document.getElementById("missed-break-end");
    let reason = reasonEl.value.trim();
    let start = startEl.value; // "HH:MM", 24hr, from <input type="time">
    let end = endEl.value;

    if (!reason) { alert("Enter what the break was for."); return; }
    if (!start || !end) { alert("Enter both a start and end time."); return; }

    // Same awake-window rule as applyMissedBreakTimeConstraints() above,
    // enforced again here as a real guard — the min/max attributes stop the
    // native time picker from landing outside the window, but don't stop a
    // typed/pasted value, so both start and end are re-checked on save.
    let wakeTime = getSleepLog()[dt]?.wakeTime;
    if (wakeTime && (timeToMinutes(start) < timeToMinutes(wakeTime) || timeToMinutes(end) < timeToMinutes(wakeTime))) {
        alert(`Breaks can only be logged after you woke up (${formatTime12Hour(wakeTime)}).`);
        return;
    }
    if (dt === getTodayKey()) {
        let now = new Date();
        let nowMin = now.getHours() * 60 + now.getMinutes();
        if (timeToMinutes(start) > nowMin || timeToMinutes(end) > nowMin) {
            alert("Break times can't be later than right now.");
            return;
        }
    }

    let [sh, sm] = start.split(":").map(Number);
    let [eh, em] = end.split(":").map(Number);
    let durationSec = ((eh * 60 + em) - (sh * 60 + sm)) * 60;
    if (durationSec <= 0) { alert("End time must be after start time."); return; }

    let db = getDB();
    if (!db[dt]) db[dt] = blankDay();
    let day = ensureDayShape(db[dt]);

    // Stamp with the START time (unlike the timer's own live break commits,
    // which stamp the end) — for a break you're logging after the fact,
    // "started at X" is what you actually remember and want listed.
    let stamp = new Date(2000, 0, 1, sh, sm).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    day.breaks.push({ id: generateId(), time: stamp, reason, duration: durationSec });
    day.totalBreak += durationSec;
    saveDB(db);

    reasonEl.value = ""; startEl.value = ""; endEl.value = "";
    loadHistoryData();
    if (dt === getTodayKey()) updateLiveSummary();
}

export function deleteBreakLog() {
    let dt = document.getElementById("history-picker").value; if (!dt) return;
    let db = getDB(); if (!db[dt]) { alert("No data."); return; }
    if (!confirm(`Delete all break logs for ${formatDateDDMMYYYY(dt)}?`)) return;
    db[dt].breaks = []; db[dt].totalBreak = 0;
    saveDB(db); loadHistoryData(); if (dt === getTodayKey()) updateLiveSummary(); renderGarden(); renderHeatmap(); renderTrendChart();
}
