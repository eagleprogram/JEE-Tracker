// week-nav.js — "which week am I viewing" state for the ‹ This Week ›
// control that sits beside each of three widgets' titles: Week's Garden,
// Question Practice Tracker, and Weekly Subject Trend.
//
// Each widget keeps its OWN offset — moving to a past week on one of them
// does NOT move the other two. shiftViewWeek(key, delta) (wired up in
// main.js) is what changes a single widget's offset and re-renders just
// that one widget + repaints just that one widget's own nav control.
//
// offset 0 = the current calendar week, and is the ONLY state each of
// those three widgets originally rendered before this feature existed —
// renderGarden()/renderQuestionsWidget()/renderTrendChart() all keep an
// `offset === 0` path that reproduces their exact original output, so
// nothing about the default view changes. State lives only in memory (a
// plain module-level object, not localStorage), so every widget is back
// on "This Week" again after any page refresh.
//
// This module only holds state + does the date math + repaints the nav
// control itself — it deliberately does NOT import charts.js or
// questions.js (which both import mondayForOffset/getWeekOffset FROM
// here) to avoid a circular-import mess; main.js is the one place that
// already imports all three widgets' render functions, so it owns calling
// the right one after its offset changes.

const MAX_WEEKS_BACK = 26; // ~6 months back — generous for a JEE prep window without letting the control scroll forever

// One independent offset per widget, keyed by the same "garden" /
// "questions" / "trend" prefix used for their element ids in index.html.
let weekOffsets = { garden: 0, questions: 0, trend: 0 };

export function getWeekOffset(key) {
    return weekOffsets[key] || 0;
}

// Clamps and stores a new offset for one widget (0 = current week,
// negative = that many weeks back; never lets the view move into the
// future). Returns the clamped value actually stored.
export function setWeekOffset(key, offset) {
    let clamped = Math.min(0, Math.max(-MAX_WEEKS_BACK, offset));
    weekOffsets[key] = clamped;
    return clamped;
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

// Repaints ONE widget's own "‹ label ›" control to match its own offset:
// the label text, and whether either arrow should be disabled (can't go
// past today, or past the MAX_WEEKS_BACK floor). Pass a specific key to
// repaint just that widget (the normal case, after shiftViewWeek()), or
// call with no argument to repaint all three at once (used once on boot).
export function renderWeekNavUI(key) {
    let keys = key ? [key] : ["garden", "questions", "trend"];
    keys.forEach((k) => {
        let offset = getWeekOffset(k);
        let monday = mondayForOffset(offset);
        let sunday = new Date(monday);
        sunday.setDate(monday.getDate() + 6);
        let label = offset === 0 ? "This Week" : `${shortDate(monday)} \u2013 ${shortDate(sunday)}`;
        let labelEl = document.getElementById(`${k}-week-label`);
        if (labelEl) labelEl.innerText = label;
        let prevBtn = document.getElementById(`${k}-week-prev`);
        if (prevBtn) prevBtn.disabled = offset <= -MAX_WEEKS_BACK;
        let nextBtn = document.getElementById(`${k}-week-next`);
        if (nextBtn) nextBtn.disabled = offset >= 0;
    });
}
