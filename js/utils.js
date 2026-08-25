import { showToast } from './ui.js';

export function formatHMS(ms) {
    let sec = Math.floor(ms / 1000);
    let h = Math.floor(sec / 3600).toString().padStart(2, '0');
    let m = Math.floor((sec % 3600) / 60).toString().padStart(2, '0');
    let s = (sec % 60).toString().padStart(2, '0');
    return `${h}:${m}:${s}`;
}

export function formatReadable(sec) {
    let h = Math.floor(sec / 3600);
    let m = Math.floor((sec % 3600) / 60);
    let s = sec % 60;
    return `${h}h ${m}m ${s}s`;
}

// BUG FIX: timer.js (live break/session commits) and history.js (manually
// added "missed" breaks) used to stamp each entry's clock time with
// `date.toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'})`. That
// output is entirely at the mercy of the browser/OS locale — it isn't
// guaranteed to be "H:MM AM/PM" with a plain space. Depending on the
// device's regional format it can come back as 24-hour ("16:20", no
// AM/PM at all), or with "am"/"pm" lowercased, or — the one that actually
// hit here — with a NARROW NO-BREAK SPACE (U+202F) before the AM/PM
// instead of a normal space, which is what recent Chrome uses for en-IN
// and several other locales. formatTime12Hour()/timeToMinutes() below
// both split on a literal " " (U+0020), so that narrow space silently
// broke the split: the AM/PM half was lost, sorting compared the wrong
// numbers, and a couple of downstream string-built spots (report/export
// text that concatenates hour+minute for a compact stamp) ended up
// gluing the hour and minute digits together with nothing in between —
// e.g. "4:20 PM" losing its separators and reading as "420".
// stampTime12Hour() below builds the exact same "HH:MM AM/PM" shape by
// hand from a Date's local hours/minutes, with a normal ASCII space,
// zero locale dependency, and guaranteed round-trip through
// formatTime12Hour()/timeToMinutes() every time.
export function stampTime12Hour(date) {
    let h = date.getHours(), m = date.getMinutes();
    let ampm = h >= 12 ? 'PM' : 'AM';
    h = h % 12 || 12;
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')} ${ampm}`;
}

export function formatTime12Hour(timeStr) {
    if (!timeStr || timeStr === "--:--" || timeStr === "—" || timeStr === "---") return "--:--";
    let h, m;
    if (timeStr.includes(':') && !timeStr.includes(' ')) {
        let parts = timeStr.split(':');
        h = Number(parts[0]); m = Number(parts[1]);
        if (!isNaN(h) && !isNaN(m)) {
            let ampm = h >= 12 ? 'PM' : 'AM';
            h = h % 12 || 12;
            return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')} ${ampm}`;
        }
    }
    let parts = timeStr.split(' ');
    if (parts.length === 2) {
        let timePart = parts[0], modifier = parts[1];
        let timeParts = timePart.split(':');
        h = Number(timeParts[0]); m = Number(timeParts[1]);
        if (!isNaN(h) && !isNaN(m) && (modifier === 'AM' || modifier === 'PM')) {
            return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')} ${modifier}`;
        }
    }
    return "--:--";
}

// Renamed from formatDateDDMMYYYY: now renders a 2-digit year (17-08-26)
// instead of 4-digit (17-08-2026) everywhere a date is shown to the user,
// per request. Still takes a "YYYY-MM-DD" storage key and only ever
// slices the last 2 digits of the year — it never reads/writes anything
// with a 2-digit year, so this is purely a display change.
export function formatDateDDMMYY(dateStr) {
    if (!dateStr) return "";
    let parts = dateStr.split('-');
    if (parts.length === 3) return `${parts[2]}-${parts[1]}-${parts[0].slice(2)}`;
    return dateStr;
}

export function fmtDuration(min) {
    if (!min || min < 0) return "—";
    let h = Math.floor(min / 60);
    let m = min % 60;
    return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

export function fmtExamDate(d) { return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }); }

export function fmtTime(t) { if (!t) return "—"; return t.split(":").slice(0, 2).join(":"); }

export function dateKey(y, m, d) { return `${y}-${(m+1).toString().padStart(2,'0')}-${d.toString().padStart(2,'0')}`; }

export function dateKeyFromWall(ms) {
    let d = new Date(ms);
    return `${d.getFullYear()}-${(d.getMonth()+1).toString().padStart(2,'0')}-${d.getDate().toString().padStart(2,'0')}`;
}

// BUG FIX: this used to be `new Date().toISOString().split('T')[0]`, which
// reads the UTC calendar date, not the user's local date. For any timezone
// ahead of UTC (e.g. IST, UTC+5:30), the UTC date doesn't roll over to
// "tomorrow" until 5:30 AM local time — so from local midnight to 5:30 AM,
// getTodayKey() still returned YESTERDAY's date while every other date key
// in this app (dateKeyFromWall, used by the timer's own commit logic) had
// already rolled over to today. That mismatch is what let stress-test/log
// entries and rollover checks land under the wrong day bucket. Routing
// through dateKeyFromWall(Date.now()) makes this always agree with the
// local-calendar-date logic the rest of the app already uses.
export function getTodayKey() { return dateKeyFromWall(Date.now()); }

// BUG FIX (feature request): a bedtime logged in the wee hours — e.g. 1:00
// AM — is really closing out the study day that was already running
// (yesterday, by feel), not opening a fresh one at literal calendar
// midnight. Everything else in the app rolls over at exact midnight
// (getTodayKey() above), which is correct for the timer/DB/logs — this
// helper is ONLY for the sleep-log quick-entry flow in sleep.js, which
// needs to know "does right-now still count as last night?" before
// deciding which day the questions-solved popup and tomorrow's Planner
// should target. 4:00 AM was chosen as the cutoff: before it, still
// "last night"; at/after it, a genuinely new day has started.
const DAY_ROLLOVER_CUTOFF_HOUR = 4;
export function isBeforeDayCutoff(date = new Date()) {
    return date.getHours() < DAY_ROLLOVER_CUTOFF_HOUR;
}

export function mondayKeyFor(d) {
    let dt = new Date(d);
    let dow = dt.getDay();
    let mondayOffset = (dow === 0) ? -6 : 1 - dow;
    dt.setDate(dt.getDate() + mondayOffset);
    return dateKeyFromWall(dt.getTime());
}

export function timeToMinutes(timeStr) {
    if (!timeStr) return 0;
    let [time, modifier] = timeStr.split(' ');
    let [h, m] = time.split(':').map(Number);
    if (modifier === 'PM' && h !== 12) h += 12;
    if (modifier === 'AM' && h === 12) h = 0;
    return h * 60 + m;
}

export function escapeHtml(s) { return s.replace(/[&<>"']/g, c => ({ "&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;" }[c])); }

export function downloadBlob(content, filename, mime) {
    let blob = new Blob([content], { type: mime });
    let url = URL.createObjectURL(blob);
    let a = document.createElement("a");
    a.href = url; a.download = filename; a.click();
    URL.revokeObjectURL(url);
    showToast(`Exported ${filename}`);
}

export function fileToDataURL(file) {
    return new Promise((resolve, reject) => {
        let reader = new FileReader();
        reader.onload = () => resolve({ name: file.name, type: file.type, dataUrl: reader.result });
        reader.onerror = reject;
        reader.readAsDataURL(file);
    });
}

export function shiftDateByYears(baseIso, years) {
    let d = new Date(baseIso);
    d.setFullYear(d.getFullYear() + years);
    return d;
}

// Stable unique id for study-session / break entries. Array *index* is not
// safe to use as an identifier for these because loadHistoryData() sorts
// (and re-saves) these arrays by time on every render — an id survives
// reordering, an index does not.
export function generateId() {
    return `${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
}
