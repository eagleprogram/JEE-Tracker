import { formatReadable, formatTime12Hour, timeToMinutes, getTodayKey, escapeHtml, formatDateDDMMYYYY } from './utils.js';
import { getDB, saveDB, ensureDayShape, blankDay } from './storage.js';
import { updateLiveSummary, resetOpenEntryRefs } from './timer.js';
import { renderGarden, renderHeatmap, renderTrendChart } from './charts.js';

export function loadHistoryData() {
    let dt = document.getElementById("history-picker").value;
    if (!dt) return;
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

export function deleteBreakLog() {
    let dt = document.getElementById("history-picker").value; if (!dt) return;
    let db = getDB(); if (!db[dt]) { alert("No data."); return; }
    if (!confirm(`Delete all break logs for ${formatDateDDMMYYYY(dt)}?`)) return;
    db[dt].breaks = []; db[dt].totalBreak = 0;
    saveDB(db); loadHistoryData(); if (dt === getTodayKey()) updateLiveSummary(); renderGarden(); renderHeatmap(); renderTrendChart();
}
