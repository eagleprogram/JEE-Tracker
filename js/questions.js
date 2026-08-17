// questions.js — "approximate no. of questions solved today" feature.
//
// Flow: whenever a sleep log entry is completed for a given calendar day
// (see sleep.js's maybeAskQuestionsSolved() calls), this module checks
// whether that day has already been asked (day.questionsAsked) and, if not,
// opens a small popup asking for the count. The count is also editable any
// time via the "Log Today's Questions" button on the tracker card, and via
// re-opening the popup for a day that already has a value (it pre-fills).
//
// Storage: day.questionsSolved (number) + day.questionsAsked (bool) live
// directly on each day object in the existing study DB (see
// blankDay()/ensureDayShape() in storage.js) — so this rides along for free
// with the existing backup export/import and Firebase cloud sync, both of
// which copy the whole day object generically without listing fields.
import { formatDateDDMMYY, getTodayKey, dateKeyFromWall } from './utils.js';
import { getDB, saveDB, initDay, ensureDayShape } from './storage.js';
// Forward reference — ui.js lands in a later step. Only called inside
// function bodies, safe once the full module graph is wired in main.js.
import { showToast } from './ui.js';
import { renderHeatmap } from './charts.js';
import { getWeekOffset, mondayForOffset } from './week-nav.js';

let activeQuestionsDateKey = null;

// Called after a sleep log entry is saved for `dateKey` (the day whose
// study is being "closed out" by that log). No-op if that day has already
// been asked (or answered/skipped) — see the field comment in storage.js.
export function maybeAskQuestionsSolved(dateKey) {
    if (!dateKey) return;
    let db = getDB();
    let day = db[dateKey];
    if (!day) day = initDay(dateKey);
    ensureDayShape(day);
    if (day.questionsAsked) return;
    openQuestionsModal(dateKey);
}

export function openQuestionsModal(dateKey) {
    if (!dateKey) dateKey = getTodayKey();
    activeQuestionsDateKey = dateKey;
    let db = getDB();
    let day = db[dateKey] || initDay(dateKey);
    ensureDayShape(day);
    document.getElementById("questions-modal-date").innerText = formatDateDDMMYY(dateKey);
    document.getElementById("questions-count-input").value = day.questionsSolved > 0 ? day.questionsSolved : "";
    document.getElementById("questions-modal").style.display = "flex";
    setTimeout(() => { let inp = document.getElementById("questions-count-input"); if (inp) inp.focus(); }, 50);
}

// Convenience wrapper for the inline onclick on the "Log Today's Questions"
// button — inline HTML handlers can't call getTodayKey() directly since
// utils.js isn't exposed on window (only functions main.js explicitly
// assigns are).
export function openTodayQuestionsModal() { openQuestionsModal(getTodayKey()); }

export function closeQuestionsModal() {
    document.getElementById("questions-modal").style.display = "none";
    activeQuestionsDateKey = null;
}

export function saveQuestionsSolved() {
    if (!activeQuestionsDateKey) { closeQuestionsModal(); return; }
    let input = document.getElementById("questions-count-input");
    let val = parseInt(input.value, 10);
    if (isNaN(val) || val < 0) { showToast("⚠️ Enter a valid number (0 or more)."); return; }
    let dateKey = activeQuestionsDateKey;
    let db = getDB();
    let day = db[dateKey] || initDay(dateKey);
    ensureDayShape(day);
    day.questionsSolved = val;
    day.questionsAsked = true;
    db[dateKey] = day;
    saveDB(db);
    closeQuestionsModal();
    renderQuestionsWidget();
    renderHeatmap();
    showToast(`✅ ${val} question${val === 1 ? '' : 's'} solved logged for ${formatDateDDMMYY(dateKey)}.`);
}

// "Back" just closes the modal without saving anything — unlike the old
// "Skip" button, it does NOT mark the day as asked, so maybeAskQuestionsSolved()
// will still prompt again next time a sleep log is saved for this day.
export function backQuestionsModal() {
    closeQuestionsModal();
}

// Clears a previously-logged count for the open day (e.g. logged by mistake)
// and re-opens it up for the auto-prompt (see backQuestionsModal's comment
// above re: questionsAsked).
export function deleteQuestionsSolved() {
    if (!activeQuestionsDateKey) { closeQuestionsModal(); return; }
    let dateKey = activeQuestionsDateKey;
    let db = getDB();
    let day = db[dateKey] || initDay(dateKey);
    ensureDayShape(day);
    day.questionsSolved = 0;
    day.questionsAsked = false;
    db[dateKey] = day;
    saveDB(db);
    closeQuestionsModal();
    renderQuestionsWidget();
    renderHeatmap();
    showToast(`Questions log deleted for ${formatDateDDMMYY(dateKey)}.`);
}

// ---------------- WEEKLY QUESTION-PRACTICE RING WIDGET ----------------
// 1-59 -> blue, 60-100 -> green, 100+ -> gold (100+ always renders as a
// FULL gold ring, same "overflow" treatment as the Garden's bonus-tree
// gold color past the 10h goal). The ring starts at the 6 o'clock
// (bottom) point and fills clockwise — SVG's default 0°/no-rotation start
// point is 3 o'clock with increasing angle already going clockwise in
// screen space, so rotating the whole circle +90° moves that start point
// to 6 o'clock while keeping the fill direction clockwise.
function questionRingColor(count) {
    if (count > 100) return "#facc15";      // gold — 100+
    if (count >= 60) return "#10b981";      // green — 60-100
    if (count >= 1) return "#38bdf8";       // blue — 1-59
    return null;                             // no data logged yet
}

function questionRingSVG(count) {
    // Ring bumped up from the old r=24/cx,cy=30/viewBox 60x60 — kept the
    // same stroke-to-radius ratio (strokeW/r) so the ring doesn't look
    // proportionally thinner or thicker, just slightly bigger overall.
    let r = 27, cx = 34, cy = 34, strokeW = 5.5;
    let circumference = 2 * Math.PI * r;
    let pct = Math.min(Math.max(count, 0), 100) / 100;
    let color = questionRingColor(count);
    let dash = circumference * pct;
    // Thin dashed track ring — a real dash pattern (elongated segments with
    // a butt linecap, not a near-zero dash length with a round linecap)
    // rendered at a thinner stroke width and reduced opacity, matching the
    // subtle, classic dashed-circle look of the reference design (as opposed
    // to the old bold, fully-opaque round-dot track).
    let track = `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="var(--border)" stroke-width="2.5" stroke-linecap="butt" stroke-dasharray="4 3.5" stroke-opacity="0.55"/>`;
    let arc = color ? `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${color}" stroke-width="${strokeW}" stroke-linecap="round" stroke-dasharray="${dash.toFixed(2)} ${(circumference - dash).toFixed(2)}" transform="rotate(90 ${cx} ${cy})"/>` : "";
    let label = count > 0 ? count : "0";
    let textColor = color || "var(--muted)";
    return `<svg width="100%" height="72" viewBox="0 0 68 68" style="max-width:68px;">
        ${track}${arc}
        <text x="${cx}" y="${cy}" text-anchor="middle" dominant-baseline="central" font-size="17" font-weight="800" fill="${textColor}">${label}</text>
    </svg>`;
}

export function renderQuestionsWidget() {
    let cont = document.getElementById("questions-row");
    if (!cont) return;
    let db = getDB();
    // Week-nav: same shared offset as the Garden/Trend widgets — see the
    // comment on renderGarden() in charts.js.
    let monday = mondayForOffset(getWeekOffset("questions"));
    let todayKey = getTodayKey();
    const dowLabels = ["MON", "TUE", "WED", "THU", "FRI", "SAT", "SUN"];
    let html = "";
    for (let i = 0; i < 7; i++) {
        let d = new Date(monday); d.setDate(monday.getDate() + i);
        let key = dateKeyFromWall(d.getTime());
        let isToday = key === todayKey;
        let count = db[key]?.questionsSolved || 0;
        html += `<div class="garden-plot ${isToday ? 'is-today' : ''}"><div class="dow-label">${dowLabels[i]}</div>${questionRingSVG(count)}</div>`;
    }
    cont.innerHTML = html;
}
