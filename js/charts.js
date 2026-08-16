import { dateKeyFromWall, getTodayKey, mondayKeyFor, formatDateDDMMYYYY } from './utils.js';
import { getDB, blankDay } from './storage.js';
import { getTimerState, getSegmentElapsedMs } from './timer.js';

export const SUBJECT_COLORS = {
    "Physics": "#14b8a6",
    "Organic Chemistry": "#dc2626",
    "Inorganic Chemistry": "#4f46e5",
    "Physical Chemistry": "#f59e0b",
    "Mathematics": "#d946ef",
    "Revision": "#84cc16",
    "School Preparation": "#f97316",
    "Mock Test / Analysis": "#0ea5e9"
};

export function gardenPlotSVG(hours, idx) {
    let step = Math.min(hours / 10, 1);
    let hitGoal = hours >= 10;
    let bonus = hours > 12;
    // Realistic tree shape with trunk, branches, and layered leaf clusters
    let trunkH = 8 + step * 14;
    let canopyR = 6 + step * 20;
    let canopyColor = bonus ? "#facc15" : (hitGoal ? "#10b981" : "#65a30d");
    let gradientColor = bonus ? "#fef08a" : (hitGoal ? "#86efac" : "#a3e635");
    let sparkles = "";
    if (hitGoal) {
        let count = Math.min(3 + Math.floor((hours - 10) / 2), 8);
        let positions = [];
        for (let i = 0; i < count; i++) {
            let angle = Math.random() * 2 * Math.PI;
            let dist = 0.3 + Math.random() * 0.6;
            let x = 28 + Math.cos(angle) * dist * 28;
            let y = 20 + Math.sin(angle) * dist * 25;
            positions.push({x, y});
        }
        sparkles = positions.map((p, i) =>
            `<text x="${p.x}" y="${p.y}" font-size="12" fill="#facc15" text-anchor="middle" filter="drop-shadow(0 0 2px #facc15)">✨</text>`
        ).join('');
    }
    return `<svg width="100%" height="66" viewBox="0 0 56 66" style="max-width:56px;">
        <defs>
            <radialGradient id="grad${idx}" cx="30%" cy="30%" r="70%">
                <stop offset="0%" stop-color="${gradientColor}" />
                <stop offset="100%" stop-color="${canopyColor}" />
            </radialGradient>
            <filter id="glow${idx}" x="-50%" y="-50%" width="200%" height="200%">
                <feGaussianBlur stdDeviation="2.5" result="b"/>
                <feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge>
            </filter>
        </defs>
        <!-- Shadow -->
        <ellipse cx="28" cy="60" rx="20" ry="4" fill="#1e293b"/>
        <!-- Main trunk -->
        <rect x="24" y="${60 - trunkH}" width="8" height="${trunkH}" rx="3" fill="#78350f" />
        <!-- Branches and leaf clusters -->
        <ellipse cx="28" cy="${60 - trunkH - canopyR * 0.6}" rx="${canopyR * 0.8}" ry="${canopyR * 0.5}" fill="url(#grad${idx})" ${hitGoal ? `filter="url(#glow${idx})"` : ''}/>
        <ellipse cx="${28 - canopyR * 0.4}" cy="${60 - trunkH - canopyR * 0.3}" rx="${canopyR * 0.6}" ry="${canopyR * 0.4}" fill="url(#grad${idx})" ${hitGoal ? `filter="url(#glow${idx})"` : ''}/>
        <ellipse cx="${28 + canopyR * 0.4}" cy="${60 - trunkH - canopyR * 0.3}" rx="${canopyR * 0.6}" ry="${canopyR * 0.4}" fill="url(#grad${idx})" ${hitGoal ? `filter="url(#glow${idx})"` : ''}/>
        <ellipse cx="28" cy="${60 - trunkH - canopyR * 0.8}" rx="${canopyR * 0.5}" ry="${canopyR * 0.4}" fill="url(#grad${idx})" ${hitGoal ? `filter="url(#glow${idx})"` : ''}/>
        <!-- Sparkles when hit goal -->
        ${sparkles}
    </svg>`;
}

export function computeStreak(db) {
    let count = 0; let d = new Date(); let todayKey = getTodayKey();
    let liveExtraSec = (getTimerState() === "STUDYING") ? Math.floor(getSegmentElapsedMs() / 1000) : 0;
    let todayHrs = ((db[todayKey]?.totalStudy || 0) + liveExtraSec) / 3600;
    if (todayHrs < 10) d.setDate(d.getDate() - 1);
    let freezeUsedForWeek = {};
    while (true) {
        let key = dateKeyFromWall(d.getTime()); let hrs = (db[key]?.totalStudy || 0) / 3600;
        if (hrs >= 10) count++;
        else { let wk = mondayKeyFor(d); if (!freezeUsedForWeek[wk]) freezeUsedForWeek[wk] = true; else break; }
        d.setDate(d.getDate() - 1); if (count > 3650) break;
    }
    return count;
}

export function renderGarden() {
    let db = getDB(); let now = new Date(); let dow = now.getDay(); let mondayOffset = (dow === 0) ? -6 : 1 - dow;
    let monday = new Date(now); monday.setDate(now.getDate() + mondayOffset); monday.setHours(0,0,0,0);
    let todayKey = getTodayKey(); const dowLabels = ["Mon","Tue","Wed","Thu","Fri","Sat","Sun"]; let html = ""; let freezeUsedThisWeek = false;
    for (let i = 0; i < 7; i++) {
        let d = new Date(monday); d.setDate(monday.getDate() + i);
        let key = dateKeyFromWall(d.getTime());
        let isToday = key === todayKey;
        let isFuture = d.getTime() > now.getTime() && !isToday;
        let sec = db[key]?.totalStudy || 0;
        if (isToday && getTimerState() === "STUDYING") sec += Math.floor(getSegmentElapsedMs() / 1000);
        let hrs = sec / 3600;
        let isFrozen = false;
        if (!isFuture && !isToday && hrs < 10 && !freezeUsedThisWeek) { isFrozen = true; freezeUsedThisWeek = true; }
        html += `<div class="garden-plot ${isToday ? 'is-today' : ''}"><div class="dow-label">${isFrozen ? '<span class="freeze-badge" title="Streak freeze used">❄️</span>' : ''}${dowLabels[i]}</div>${gardenPlotSVG(hrs, i)}<div class="hrs-label">${hrs.toFixed(1)}h</div></div>`;
    }
    document.getElementById("garden-row").innerHTML = html;
    document.getElementById("streak-pill").innerText = `🔥 ${computeStreak(db)} day streak`;
}

// ---------------- HEATMAP ----------------
// BUG FIX (round 5): replaced the GitHub-style calendar-aligned grid
// (weeks starting on a fixed Sunday, rows = real day-of-week) with a
// plain sequential fill. The old approach always allocated a full 7-day
// column for the current week even though most of those days hadn't
// happened yet, so "today" ended up stranded mid-grid with a dead,
// mostly-empty column trailing to its right. Here the day list is built
// with NO days past today (so nothing to skip/leave blank), then simply
// chunked into columns of 7 from oldest to newest — the last column is
// naturally partial and its last cell is always today, flush against the
// right edge, with the rest of that week's data trailing left one day at
// a time. No calendar/weekday alignment is implied by row position
// anymore. Color scale, tooltip, legend and geometry are unchanged.
export function renderHeatmap() {
    let db = getDB(); let today = new Date(); today.setHours(0,0,0,0);
    const totalDays = 372; // ~12 months, same range as before
    let start = new Date(today); start.setDate(today.getDate() - (totalDays - 1));
    let days = []; let cursor = new Date(start);
    while (cursor <= today) {
        let key = dateKeyFromWall(cursor.getTime());
        let sec = db[key]?.totalStudy || 0;
        let q = db[key]?.questionsSolved || 0;
        days.push({ key, hrs: sec / 3600, q });
        cursor.setDate(cursor.getDate() + 1);
    }
    const rows = 7;
    let weeks = [];
    for (let i = 0; i < days.length; i += rows) weeks.push(days.slice(i, i + rows));

    // BUG FIX (round 2): reverted to the original larger tile geometry
    // (13px cell, 4px gap, rx3) the user wants back — the small/tight
    // GitHub-proportioned tiles from the previous fix were the wrong
    // target; only the COLOR treatment (below) should follow GitHub's
    // dark, low-contrast style, not the size.
    let cell = 13; let gap = 4; let width = weeks.length * (cell + gap) + 16; let height = rows * (cell + gap) + 10; let svg = `<svg viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" preserveAspectRatio="xMidYMid meet" style="width:100%; height:auto; max-width:${width}px; display:block;">`;
    // BUG FIX: the previous version used a genuine multi-hue scale (blue ->
    // green -> amber -> rose per bucket) specifically because a single-hue
    // ramp was hard to split into confident buckets. Feedback was the exact
    // opposite: a different COLOR per bucket makes the grid read as
    // categories, not a single "more = more" scale, which is harder to
    // scan at a glance than one hue getting steadily more intense. Back to
    // one hue (blue, matching --primary/--tint-sky used everywhere else in
    // the app) with 5 brightness/saturation steps.
    //
    // FOLLOW-UP FIX #3: the 0h tile (#33415c) read as too strong/too close
    // in brightness to the filled tiles above it — at a glance the "empty"
    // days weren't clearly receding into the background the way an empty
    // cell should. Swapped in the requested darker 5-step palette: 0h now
    // sits much closer to the page background (quiet, clearly "no data")
    // while 10h+ is a bright, saturated sky blue, so the ramp reads as a
    // clean gradient from "nothing logged" to "goal hit" instead of every
    // bucket fighting for attention equally.
    // BUG FIX (round 4): the whole ramp, not just the 0h tile, was too
    // close to the card background (--card: #131b2b) to read as distinct
    // squares — "dark" was overshooting into "invisible" across every
    // bucket. Brightened all 5 steps by a consistent amount (keeping the
    // same hue progression and relative spacing between buckets) so every
    // tile is clearly a square against the background, while still
    // staying a low-contrast, GitHub-style dark scale rather than the
    // earlier bright/saturated version. Geometry and the stroke-free fill
    // are untouched.
    const hmColors = ["#233252", "#2c5a9e", "#3a91c9", "#5cc0e8", "#a3e0f8"];
    // BUG FIX (round 2): GitHub's real contribution grid has NO stroke at
    // all — flat, solid fills only, with adjacent cells separated purely
    // by the gap between them, not by a border. The previous "hairline"
    // stroke was still a visible outline against the dark background.
    // Dropped stroke/stroke-width entirely.
    weeks.forEach((week, wi) => {
        week.forEach((day, di) => {
            let x = wi * (cell + gap) + 8, y = di * (cell + gap) + 5;
            // Buckets now span the full 0-10h daily goal so the brightest
            // color is only reached at the actual goal (10h+), not 9h —
            // matches the updated "10h+" legend label in index.html.
            let colorIdx = day.hrs >= 10 ? 4 : day.hrs > 6 ? 3 : day.hrs > 3 ? 2 : day.hrs > 0 ? 1 : 0;
            svg += `<rect x="${x}" y="${y}" width="${cell}" height="${cell}" rx="3" fill="${hmColors[colorIdx]}"><title>${formatDateDDMMYYYY(day.key)}: ${day.hrs.toFixed(1)}hr & ${day.q}Q</title></rect>`;
        });
    });
    svg += `</svg>`;
    document.getElementById("heatmap-container").innerHTML = svg;
}

// ---------------- TREND CHART ----------------
export function renderTrendChart() {
    let db = getDB(); let today = new Date(); today.setHours(0,0,0,0);
    let days = []; for (let i = 6; i >= 0; i--) { let d = new Date(today); d.setDate(today.getDate() - i); days.push(dateKeyFromWall(d.getTime())); }
    let subjects = Object.keys(blankDay().subjects); let width = 1200, height = 400, padding = 60;
    // Fixed floor of 10h (the daily study goal) instead of 0.5h — a 0.5h
    // ceiling made every gridline within a hair of 0 and the chart looked
    // broken/empty even on days with real data. If actual logged hours ever
    // exceed 10 in the last 7 days, the axis still grows to fit them.
    let maxHrs = 10;
    days.forEach(key => { let day = db[key]; if (day) subjects.forEach(s => { maxHrs = Math.max(maxHrs, (day.subjects[s]||0)/3600); }); });
    let xStep = (width - padding * 2) / (days.length - 1);
    let svg = `<svg width="100%" height="${height}" viewBox="0 0 ${width} ${height}" preserveAspectRatio="xMinYMin meet">`;
    for (let g = 0; g <= 4; g++) { let y = padding + (height - padding * 2) * (g / 4); svg += `<line x1="${padding}" y1="${y}" x2="${width-padding}" y2="${y}" stroke="#232f48" stroke-width="1"/><text x="4" y="${y+4}" font-size="12" fill="#64748b">${(maxHrs*(1-g/4)).toFixed(1)}h</text>`; }
    days.forEach((key, i) => { let x = padding + i * xStep; let lbl = new Date(key + "T00:00:00").toLocaleDateString([], { weekday: 'short' }); svg += `<text x="${x}" y="${height-8}" font-size="12" fill="#64748b" text-anchor="middle">${lbl}</text>`; });
    let anyData = false;
    subjects.forEach(subj => {
        let hasAny = days.some(key => db[key] && (db[key].subjects[subj]||0) > 0);
        if (!hasAny) return;
        anyData = true;
        let color = SUBJECT_COLORS[subj] || "#64748b";
        let pts = days.map((key, i) => {
            let day = db[key]; let hrs = day ? (day.subjects[subj]||0)/3600 : 0;
            let x = padding + i * xStep; let y = padding + (height - padding * 2) * (1 - hrs / maxHrs);
            return [x, y];
        });
        svg += `<polyline points="${pts.map(p=>p.join(',')).join(' ')}" fill="none" stroke="${color}" stroke-width="3.5"/>`;
        pts.forEach(([x,y]) => { svg += `<circle cx="${x}" cy="${y}" r="5" fill="${color}"/>`; });
    });
    svg += `</svg>`;
    let legend = `<div style="display:flex; flex-wrap:wrap; gap:16px; margin-top:10px;">`;
    subjects.forEach(subj => {
        let hasAny = days.some(key => db[key] && (db[key].subjects[subj]||0) > 0);
        if (!hasAny) return;
        legend += `<div style="display:flex; align-items:center; gap:6px; font-size:13px;"><span style="width:14px;height:14px;border-radius:3px;background:${SUBJECT_COLORS[subj]};display:inline-block;"></span>${subj}</div>`;
    });
    legend += `</div>`;
    document.getElementById("trend-chart-container").innerHTML = anyData ? (svg + legend) : "<div class='small-note'>No study data logged in the last 7 days yet.</div>";
}
