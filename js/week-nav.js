// week-nav.js — shared "which week am I viewing" state for the three
// weekly widgets that each show one Monday–Sunday week of data at a time:
// Week's Garden, Question Practice Tracker, and Weekly Subject Trend.
//
// A single offset drives all three, so moving to a past week in ANY one of
// them moves all three together — that's the ‹ This Week › control
// repeated under each of their titles in index.html. shiftViewWeek()
// (wired up in main.js) is what actually changes the offset and
// re-renders all three widgets + this control afterwards.
//
// offset 0 = the current calendar week, and is the ONLY state each of
// those three widgets originally rendered before this feature existed —
// renderGarden()/renderQuestionsWidget()/renderTrendChart() all keep an
// `offset === 0` path that reproduces their exact original output, so nothing
// about the default view changes.
//
// This module only holds state + does the date math + repaints the little
// nav control itself — it deliberately does NOT import charts.js or
// questions.js (which both import mondayForOffset/getViewWeekOffset FROM
// here) to avoid a circular-import mess; main.js is the one place that
// already imports all three widgets' render functions, so it owns calling
// them after the offset changes.

const MAX_WEEKS_BACK = 26; // ~6 months back — generous for a JEE prep window without letting the control scroll forever

let viewWeekOffset = 0;

export function getViewWeekOffset() {
    return viewWeekOffset;
}

// Clamps and stores a new offset (0 = current week, negative = that many
// weeks back; never lets the view move into the future). Returns the
// clamped value actually stored.
export function setViewWeekOffset(offset) {
    viewWeekOffset = Math.min(0, Math.max(-MAX_WEEKS_BACK, offset));
    return viewWeekOffset;
}

// The Monday (00:00 local time) of the calendar week `offset` weeks back
// from the current one. offset 0 reproduces the exact Monday-finding math
// the Garden/Questions widgets already used before this feature existed.
export function mondayForOffset(offset) {
    let now = new Date();
    let dow = now.getDay();
    let mondayOffset = (dow === 0) ? -6 : 1 - dow;
    let monday = new Date(now);
    monday.setDate(now.getDate() + mondayOffset + offset * 7);
    monday.setHours(0, 0, 0, 0);
    return monday;
}

function shortDate(d) {
    return `${d.getDate()} ${d.toLocaleDateString('en-GB', { month: 'short' })}`;
}

// Repaints the three identical "‹ label ›" controls (one under each
// widget's title) to match the current offset: the label text, and
// whether either arrow should be disabled (can't go past today, or past
// the MAX_WEEKS_BACK floor).
export function renderWeekNavUI() {
    let monday = mondayForOffset(viewWeekOffset);
    let sunday = new Date(monday);
    sunday.setDate(monday.getDate() + 6);
    let label = viewWeekOffset === 0 ? "This Week" : `${shortDate(monday)} \u2013 ${shortDate(sunday)}`;
    let atOldest = viewWeekOffset <= -MAX_WEEKS_BACK;
    let atNewest = viewWeekOffset >= 0;
    ["garden", "questions", "trend"].forEach((prefix) => {
        let labelEl = document.getElementById(`${prefix}-week-label`);
        if (labelEl) labelEl.innerText = label;
        let prevBtn = document.getElementById(`${prefix}-week-prev`);
        if (prevBtn) prevBtn.disabled = atOldest;
        let nextBtn = document.getElementById(`${prefix}-week-next`);
        if (nextBtn) nextBtn.disabled = atNewest;
    });
}
