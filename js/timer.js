import { formatHMS, formatReadable, dateKeyFromWall, getTodayKey, generateId } from './utils.js';
import { getDB, saveDB, blankDay, ensureDayShape, initToday, saveActiveSessionRaw, readActiveSessionRaw, clearActiveSessionRaw, getRawFlag, setRawFlag, clearRawFlag, getTabId } from './storage.js';
// Forward references to modules landing in later steps — safe because these
// are only invoked inside function bodies, after the full module graph
// (wired together in main.js, Step 7) has loaded.
import { loadHistoryData } from './history.js';
import { renderGarden, renderHeatmap, renderTrendChart } from './charts.js';
// Forward reference — ui.js imports several things from THIS module
// (getCurrentDayKey, flushAndRestartSegment, updateLiveSummary, etc.), so
// this is a circular import, same as the history.js/charts.js ones above.
// Safe for the same reason: enterZenMode is only ever invoked from inside a
// function body (confirmStartStudy/resumeStudy), never at module-evaluation
// time, so it doesn't matter that ui.js hasn't finished initializing yet
// when this file is first parsed.
import { enterZenMode, lockBodyScroll, unlockBodyScroll } from './ui.js';

// ----------------- TIMER ENGINE -----------------
let timerState = "IDLE";
window.addEventListener("beforeunload", (e) => {
    if (timerState === "STUDYING" || timerState === "BREAK") {
        e.preventDefault();
        e.returnValue = "A study session is still running. Are you sure you want to leave and stop it?";
        return e.returnValue;
    }
});
let segmentStartWallMs = 0;
let segmentElapsedMs = 0;
// BUG FIX: this used to be sessionStudyMs, a raw-millisecond accumulator
// (`sessionStudyMs += segmentElapsedMs` on every commit). The blue
// "CURRENT SESSION" timer built its committed base from that full-precision
// ms total, while the Total Study / subject rows in Today's Live Summary
// are built from cachedTodayDay.totalStudy — a whole-SECONDS integer that
// commitActiveSegment() produces by flooring each chunk and deferring the
// leftover fraction into carryMs for the next commit (see that function's
// comment). Those are two different units of the same underlying time, so
// on every frame the blue timer would float up to ~1s ahead of the panel
// the moment any carryMs fraction had piled up — a small, real,
// deterministic rounding gap, not actual async timing drift. Tracking the
// session total in whole seconds instead, incremented by the exact same
// chunkSec values that land in the DB, guarantees both displays floor to
// the identical number every single frame.
let sessionStudySec = 0;
let animFrame = null;
let autosaveInterval = null;
let currentSegmentId = 0;
let openEntryRefs = {};
let currentDayKey = null;
// BUG FIX: commitActiveSegment() converts each chunk's elapsed ms to whole
// seconds with Math.floor() before storing, and used to just discard the
// leftover fraction (up to 999ms) every single time it ran. It runs on
// every pause, resume, break, subject switch, tab-hide, pagehide, and every
// 20s autosave tick — so on a long study session those sub-second losses
// compound into real, systematic missing minutes (this is exactly what the
// stress test's "Sum of Study Session Durations" / "Total Study Time"
// mismatches were catching). carryMs banks the leftover fraction from each
// commit and folds it into the next one instead of dropping it, so no time
// is ever permanently lost — only ever deferred to the next chunk.
let carryMs = 0;
let activeSubject = "Physics";
let activeBreakReason = "Break";
// Cache for updateLiveSummaryFast() (used by the tick() hot loop) — see
// that function for why. Refreshed on segment start/commit, and self-heals
// on the next frame if a midnight rollover makes it stale in the meantime.
let cachedTodayDay = null;
let cachedTodayDayKey = null;
function refreshCachedTodayDay() {
    cachedTodayDayKey = getTodayKey();
    cachedTodayDay = getDB()[cachedTodayDayKey] || blankDay();
}

// currentDayKey is read here but written from ui.js (checkDayRollover) and
// main.js (window.onload) — both live in other modules, so they call this
// setter rather than reassigning an imported binding (ES module imports are
// read-only in the importing module).
//
// BUG FIX: setCurrentDayKey() used to only ever set the in-memory variable
// above. main.js's boot sequence called setCurrentDayKey(getTodayKey()) on
// EVERY page load, which meant checkDayRollover()'s very first comparison
// (nowKey === getCurrentDayKey()) was always true right after a fresh
// load/reopen — so a rollover that happened while the tab was closed
// overnight (the normal case: close the app at night, reopen the next
// morning) was never detected, and carryOverIncompleteTodos() never ran.
// It only ever worked if the tab was left open and running continuously
// through the actual midnight tick. Now every call to setCurrentDayKey()
// also persists the day key to localStorage, and main.js restores FROM
// that persisted value at boot (see getPersistedDayKey()) instead of
// blindly stamping "today" — so a genuine overnight rollover is correctly
// detected and caught up on the next time the app is opened.
const LAST_ACTIVE_DAY_FLAG = "jee_last_active_day";
export function setCurrentDayKey(key) { currentDayKey = key; setRawFlag(LAST_ACTIVE_DAY_FLAG, key); }
export function getCurrentDayKey() { return currentDayKey; }
// Boot-time restore only — falls back to today on a brand-new install
// (nothing to compare against yet; using today there would make the first
// rollover check silently skip since there's no prior day to catch up).
export function getPersistedDayKey() { return getRawFlag(LAST_ACTIVE_DAY_FLAG) || getTodayKey(); }
export function getTimerState() { return timerState; }
export function getActiveSubject() { return activeSubject; }
export function getSegmentElapsedMs() { return segmentElapsedMs; }
// history.js's per-entry delete functions clear this after splicing an
// array (matches original: `openEntryRefs = {};` inline). Exposed as a
// setter since openEntryRefs is private to this module.
export function resetOpenEntryRefs() { openEntryRefs = {}; }

// ----------------- CROSS-TAB SESSION LOCK -----------------
// BUG FIX: opening the site in a second tab/window (or accepting the "you
// had an unfinished session — resume it?" prompt in a fresh tab while the
// original tab was still open and running) let two tabs independently run
// and autosave-commit the SAME logical study/break segment. Each tab only
// ever displays ITS OWN local elapsed time (session-timer), but both were
// writing their own elapsed chunks into the same shared day.totalBreak /
// day.totalStudy in localStorage — so the Today's Live Summary total
// climbed roughly twice as fast as any single tab's own on-screen timer,
// exactly the "Break Duration says +1s but Total Breaks jumped +6s"
// mismatch reported. This lock makes one tab the sole owner of an active
// session: the owning tab refreshes a heartbeat in localStorage every few
// seconds, and every other tab's Start/Break controls disable themselves
// (with an explanation) for as long as that heartbeat stays fresh.
const SESSION_LOCK_KEY = "jee_session_lock";
const LOCK_HEARTBEAT_MS = 3000;
// Comfortably more than 2x the heartbeat interval so one missed/delayed
// tick (a throttled background tab, a slow frame) never makes a still-live
// owning tab look stale to everyone else — while still clearing out within
// a few seconds of a tab actually closing/crashing without a clean unload.
const LOCK_STALE_MS = 9000;

function readSessionLock() {
    let raw = getRawFlag(SESSION_LOCK_KEY);
    if (!raw) return null;
    try { return JSON.parse(raw); } catch (e) { return null; }
}

// Returns the lock info if a DIFFERENT, still-live tab currently owns an
// active session, or null if the lock is free (never claimed, stale/dead,
// or owned by this very tab).
function otherTabActiveLock() {
    let lock = readSessionLock();
    if (!lock || !lock.tabId || lock.tabId === getTabId()) return null;
    if (Date.now() - lock.ts > LOCK_STALE_MS) return null;
    return lock;
}

function writeSessionLockHeartbeat() {
    if (timerState === "STUDYING" || timerState === "PAUSED" || timerState === "BREAK") {
        let label = timerState === "BREAK" ? `on break (${activeBreakReason})` : `studying ${activeSubject}`;
        setRawFlag(SESSION_LOCK_KEY, JSON.stringify({ tabId: getTabId(), ts: Date.now(), label }));
    } else {
        // IDLE: release the lock, but only if WE are the ones holding it —
        // never clear another live tab's active lock just because this tab
        // happens to be idle.
        let lock = readSessionLock();
        if (lock && lock.tabId === getTabId()) clearRawFlag(SESSION_LOCK_KEY);
    }
}
setInterval(writeSessionLockHeartbeat, LOCK_HEARTBEAT_MS);

// 'storage' fires in every OTHER tab (never the tab that made the change)
// the instant the lock key changes — lets a second, otherwise-idle tab
// react immediately (grey out/re-enable Start & Break) instead of waiting
// on its own next heartbeat tick.
window.addEventListener("storage", (e) => { if (e.key === SESSION_LOCK_KEY) updateUIState(); });

// Shared guard for every click-time entry point that can start a BRAND NEW
// session on this tab (fresh Start, or Break taken directly from IDLE).
// Resuming an already-owned session (PAUSED -> resume, BREAK -> back to
// study) never calls this — this tab already holds the lock in those cases.
function blockedByOtherTab() {
    let lock = otherTabActiveLock();
    if (!lock) return false;
    alert(`Another tab already has an active session running on this device (${lock.label}).\n\nFinish or close that tab first — running two at once double-counts your time.`);
    updateUIState();
    return true;
}

export function startSegment() {
    segmentStartWallMs = Date.now();
    segmentElapsedMs = 0;
    refreshCachedTodayDay();
    persistActiveSession();
}

export function commitActiveSegment() {
    // BUG FIX: this used to run unconditionally, even when timerState was
    // "PAUSED" or "IDLE". takeBreak() is reachable directly from PAUSED (the
    // Break button stays visible while paused — see index.html), and it
    // calls commitActiveSegment() before switching state to BREAK. Because
    // pauseStudy() never resets segmentStartWallMs, that stale call computed
    // elapsed time going all the way back to the ORIGINAL study start (study
    // time + the entire paused gap), not just the pause duration. The state
    // check below correctly stopped that bogus total from being written to
    // any subject/day (PAUSED matches neither the STUDYING nor BREAK branch)
    // — but the carryMs fractional-second remainder from that bogus
    // calculation was still being kept and would leak up to ~999ms of
    // phantom time into the next *real* segment's commit. Bailing out here
    // whenever we're not actually STUDYING or on a BREAK stops that leak at
    // the source, and also skips a wasted loop + saveDB() call.
    if (timerState !== "STUDYING" && timerState !== "BREAK") return;
    // BUG FIX: this used to be `performance.now() - segmentStartPerf`.
    // performance.now() is a MONOTONIC clock, and on several real-device
    // scenarios that matter a lot for a study timer — phone screen locks
    // and the OS actually suspends the browser process, laptop lid closed,
    // a backgrounded mobile tab getting frozen for an extended stretch —
    // that monotonic clock does not reliably keep advancing through the
    // suspend the way a plain wall clock does. The practical symptom
    // reported: leave the tab running in the background (switch tabs,
    // watch a lecture elsewhere, lock the phone) and come back to a
    // session/break timer that under-counted the real elapsed time, or a
    // display that looked "stuck"/laggy catching up. Date.now() is tied to
    // the system wall clock, not a suspendable monotonic counter, so a
    // diff against it always reflects the true real-world elapsed time
    // regardless of what the JS engine itself was doing (or not doing) in
    // between — exactly the same reasoning wallStart/wallEnd below already
    // relied on Date.now() for; this just makes the duration itself use
    // the same clock instead of mixing two different ones.
    let nowWallMs = Date.now();
    segmentElapsedMs = nowWallMs - segmentStartWallMs;
    if (segmentElapsedMs <= 0) return;
    let wallStart = segmentStartWallMs;
    let wallEnd = wallStart + segmentElapsedMs;
    let db = getDB();
    let cursor = wallStart;
    let committedStudySecThisCall = 0;
    while (cursor < wallEnd) {
        let cd = new Date(cursor);
        let nextMidnight = new Date(cd.getFullYear(), cd.getMonth(), cd.getDate() + 1, 0, 0, 0, 0).getTime();
        let chunkEnd = Math.min(nextMidnight, wallEnd);
        let chunkMs = chunkEnd - cursor;
        // Fold in whatever fraction of a second was left over from the
        // previous commit (any state) before flooring, then bank whatever
        // fraction is left over *this* time for the next commit.
        let roundedMs = chunkMs + carryMs;
        let chunkSec = Math.floor(roundedMs / 1000);
        carryMs = roundedMs - chunkSec * 1000;
        let dayKey = dateKeyFromWall(cursor);
        if (chunkSec > 0) {
            if (!db[dayKey]) db[dayKey] = blankDay();
            let day = ensureDayShape(db[dayKey]);
            let refKey = `${currentSegmentId}:${dayKey}:${timerState}`;
            let stamp = new Date(chunkEnd).toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'});
            if (timerState === "STUDYING") {
                day.subjects[activeSubject] = (day.subjects[activeSubject] || 0) + chunkSec;
                day.totalStudy += chunkSec;
                committedStudySecThisCall += chunkSec;
                let ref = openEntryRefs[refKey];
                let existing = ref ? day.studySessions.find(s => s.id === ref.id) : null;
                if (existing && existing.subject === activeSubject) {
                    existing.duration += chunkSec;
                    existing.time = stamp;
                } else {
                    let newEntry = { id: generateId(), time: stamp, subject: activeSubject, duration: chunkSec };
                    day.studySessions.push(newEntry);
                    openEntryRefs[refKey] = { id: newEntry.id };
                }
            } else if (timerState === "BREAK") {
                day.totalBreak += chunkSec;
                let ref = openEntryRefs[refKey];
                let existing = ref ? day.breaks.find(b => b.id === ref.id) : null;
                if (existing) {
                    existing.duration += chunkSec;
                    existing.time = stamp;
                } else {
                    let newEntry = { id: generateId(), time: stamp, reason: activeBreakReason, duration: chunkSec };
                    day.breaks.push(newEntry);
                    openEntryRefs[refKey] = { id: newEntry.id };
                }
            }
        }
        cursor = chunkEnd;
    }
    if (timerState === "STUDYING") sessionStudySec += committedStudySecThisCall;
    saveDB(db);
    refreshCachedTodayDay();
}

export function flushAndRestartSegment() {
    if (timerState !== "STUDYING" && timerState !== "BREAK") return;
    commitActiveSegment(); startSegment();
}

export function startAutosave() {
    if (autosaveInterval) clearInterval(autosaveInterval);
    autosaveInterval = setInterval(flushAndRestartSegment, 20000);
}

export function persistActiveSession() {
    if (timerState === "STUDYING" || timerState === "BREAK") {
        saveActiveSessionRaw({ state: timerState, activeSubject, activeBreakReason, segmentStartWallMs, sessionStudySec, dayKey: currentDayKey });
    } else { clearActiveSessionRaw(); }
}

export function clearActiveSession() { clearActiveSessionRaw(); }

export function tryRestoreActiveSession() {
    let raw = readActiveSessionRaw(); if (!raw) return;
    let snap; try { snap = JSON.parse(raw); } catch(e) { clearActiveSessionRaw(); return; }
    if (snap.dayKey && snap.dayKey !== getTodayKey()) { clearActiveSessionRaw(); return; }
    // BUG FIX: this snapshot lives in a plain (non tab-scoped) localStorage
    // key, so a second tab opened while the first is still genuinely
    // running would find it too and offer to "resume" a session that's
    // already live elsewhere — accepting that is exactly how two tabs ended
    // up double-committing the same segment (see the cross-tab lock above).
    // If another tab currently owns an active lock, that session is already
    // running live there — don't even offer to restore it here.
    if (otherTabActiveLock()) return;
    let label = snap.state === "STUDYING" ? `studying ${snap.activeSubject}` : `on a break (${snap.activeBreakReason})`;
    if (confirm(`You had an unfinished session (${label}) running when this tab last closed.\n\nResume it now?`)) {
        timerState = snap.state; activeSubject = snap.activeSubject; activeBreakReason = snap.activeBreakReason; sessionStudySec = snap.sessionStudySec || 0; currentSegmentId++; startSegment(); updateUIState(); tick();
    } else { clearActiveSessionRaw(); }
}

// BUG FIX: this modal used to just set display:flex with no scroll lock of
// its own, so the dashboard behind it stayed fully scrollable the whole
// time it was up — visible as a live scrollbar/scrollable background
// directly behind the "Select Subject" dialog. It now takes the same
// shared lockBodyScroll() counter as Zen Mode/the alarm modal/the guest
// reminder (see ui.js), and confirmStartStudy()/cancelSubjectModal() below
// each release exactly one lock on their way out — so the background is
// non-scrollable for the modal's entire time on screen, including the brief
// window between it closing and Zen Mode (or nothing, on Back) taking over.
export function openSubjectModal() {
    if (timerState === "PAUSED") { resumeStudy(); return; }
    if (timerState === "BREAK") { commitActiveSegment(); cancelAnimationFrame(animFrame); clearActiveSession(); }
    // Only a genuinely fresh start (from IDLE) needs the cross-tab check —
    // PAUSED/BREAK above already returned/branch into this tab's own
    // already-owned session.
    if (timerState === "IDLE" && blockedByOtherTab()) return;
    document.getElementById("modal-subject-select").value = activeSubject;
    document.getElementById("subject-modal").style.display = "flex";
    lockBodyScroll();
}

// BUG FIX: the old inline onclick just hid the modal. If openSubjectModal()
// was entered from BREAK, it had already committed the segment, cancelled
// the tick loop, and cleared the persisted session — so hitting the old
// "Back" left timerState stuck on "BREAK" with no running tick and no
// active-session record: a frozen phantom break. This restarts the break
// segment/tick (mirroring resumeStudy's pattern) before closing the modal.
export function cancelSubjectModal() {
    document.getElementById("subject-modal").style.display = "none";
    unlockBodyScroll(); // release the lock openSubjectModal() took — Back never enters Zen Mode
    if (timerState === "BREAK") {
        // NOT currentSegmentId++ — openSubjectModal()'s BREAK branch (above)
        // never incremented it either, so this is still the same real-world
        // break. Incrementing here would change the refKey commitActiveSegment()
        // uses to find the existing log entry, forking a duplicate break row
        // instead of extending the original one.
        startSegment(); updateUIState(); tick();
    }
}

export function confirmStartStudy() {
    activeSubject = document.getElementById("modal-subject-select").value;
    document.getElementById("subject-modal").style.display = "none";
    unlockBodyScroll(); // release the modal's own lock — enterZenMode() below takes its own
    timerState = "STUDYING"; currentSegmentId++; startSegment();
    updateUIState(); tick();
    // Fresh study start (main-page Start button, or Resume Study after a
    // break — both route through here) always drops straight into Zen Mode,
    // whether or not the user touched the dedicated zen toggle themselves.
    enterZenMode();
}

export function pauseStudy() { commitActiveSegment(); cancelAnimationFrame(animFrame); timerState = "PAUSED"; clearActiveSession(); updateUIState(); }

export function resumeStudy() {
    timerState = "STUDYING"; currentSegmentId++; startSegment(); updateUIState(); tick();
    // "Resume" from PAUSED also counts as (re)starting a study session — same
    // auto-zen behavior as confirmStartStudy() above.
    enterZenMode();
}

export function takeBreak() {
    // takeBreak() is reachable directly from IDLE (the Break button stays
    // visible there — see index.html), so a fresh break needs the same
    // cross-tab check as a fresh Start. Coming from STUDYING/PAUSED, this
    // tab already owns the session, so no check needed there.
    if (timerState === "IDLE" && blockedByOtherTab()) return;
    commitActiveSegment(); cancelAnimationFrame(animFrame);
    let reason = prompt("Break Reason (e.g. Lunch, Walk, Phone):");
    if (!reason || !reason.trim()) reason = "Short Break";
    activeBreakReason = reason;
    timerState = "BREAK"; currentSegmentId++; startSegment();
    updateUIState(); tick();
}

export function changeSubjectMidSession() { activeSubject = document.getElementById("switch-subject-select").value; updateLiveSummary(); }

export function endDay() {
    commitActiveSegment(); cancelAnimationFrame(animFrame);
    timerState = "IDLE"; segmentElapsedMs = 0; sessionStudySec = 0; carryMs = 0; clearActiveSession();
    updateUIState();
    document.getElementById("session-timer").innerText = "00:00:00";
    updateLiveSummary(); loadHistoryData(); renderGarden(); renderHeatmap(); renderTrendChart();
}

export function tick() {
    // Same wall-clock fix as commitActiveSegment() above — see its comment.
    segmentElapsedMs = Date.now() - segmentStartWallMs;
    if (timerState === "STUDYING") document.getElementById("session-timer").innerText = formatHMS(sessionStudySec * 1000 + segmentElapsedMs);
    else if (timerState === "BREAK") document.getElementById("session-timer").innerText = formatHMS(segmentElapsedMs);
    updateLiveSummaryFast();
    animFrame = requestAnimationFrame(tick);
}

// Runs on every animation frame (~60/sec) while a session is active — a
// cheap alternative to updateLiveSummary() for the hot loop specifically.
// updateLiveSummary() re-reads and JSON.parses the entire study database
// from localStorage every time it's called, which is fine for the
// occasional call (button clicks, history deletes) but was pointless,
// repeated work 60x/second here, and could be a real cost once the
// database has months of entries. This uses the cached totals instead
// (refreshed only when they actually change, in startSegment()/
// commitActiveSegment()) and adds the live in-progress seconds on top —
// same numbers, without re-parsing anything every frame. Falls back to the
// full accurate path (and re-caches) if the cache is missing or has gone
// stale across a midnight rollover.
function updateLiveSummaryFast() {
    if (!cachedTodayDay || cachedTodayDayKey !== getTodayKey()) { updateLiveSummary(); refreshCachedTodayDay(); return; }
    let liveStudySec = (timerState === "STUDYING") ? Math.floor(segmentElapsedMs / 1000) : 0;
    let liveBreakSec = (timerState === "BREAK") ? Math.floor(segmentElapsedMs / 1000) : 0;
    document.getElementById("live-study-val").innerText = formatReadable(cachedTodayDay.totalStudy + liveStudySec);
    document.getElementById("live-break-val").innerText = formatReadable(cachedTodayDay.totalBreak + liveBreakSec);
    let html = "";
    for (let [cat, sec] of Object.entries(cachedTodayDay.subjects)) {
        let add = (timerState === "STUDYING" && activeSubject === cat) ? liveStudySec : 0;
        html += `<div class="stat-row"><span style="color:var(--muted);">${cat}:</span><strong>${formatReadable(sec + add)}</strong></div>`;
    }
    document.getElementById("live-subject-list").innerHTML = html;
}

export function updateUIState() {
    if (timerState === "STUDYING" || timerState === "BREAK") requestWakeLock(); else releaseWakeLock();
    let badge = document.getElementById("status-badge");
    let btnStart = document.getElementById("btn-start");
    let btnPause = document.getElementById("btn-pause");
    let btnBreak = document.getElementById("btn-break");
    let btnStop = document.getElementById("btn-stop");
    let changeSub = document.getElementById("change-subject-box");
    let sessionLabel = document.getElementById("session-label");
    let lockNote = document.getElementById("session-lock-note");
    let otherLock = (timerState === "IDLE") ? otherTabActiveLock() : null;
    if (lockNote) {
        lockNote.style.display = otherLock ? "block" : "none";
        if (otherLock) lockNote.innerText = `⚠ Active session running in another tab (${otherLock.label}). Finish it there first — starting one here too would double-count time.`;
    }
    // Reset here so a state that no longer needs the cross-tab check (e.g.
    // this tab going STUDYING/BREAK itself) never keeps a stale disabled
    // control from an earlier IDLE render.
    btnStart.disabled = false; btnBreak.disabled = false;

    if (timerState === "STUDYING") {
        badge.className = "badge badge-studying"; badge.innerText = `STUDYING: ${activeSubject}`;
        sessionLabel.innerText = "CURRENT SESSION";
        btnStart.style.display = "none"; btnPause.style.display = "inline-block"; btnBreak.style.display = "inline-block"; btnStop.style.display = "inline-block"; changeSub.style.display = "none";
    } else if (timerState === "PAUSED") {
        badge.className = "badge badge-paused"; badge.innerText = `PAUSED (AT DESK)`;
        sessionLabel.innerText = "CURRENT SESSION (paused)";
        btnStart.innerText = "Resume"; btnStart.style.display = "inline-block"; btnPause.style.display = "none"; btnBreak.style.display = "inline-block"; btnStop.style.display = "inline-block"; changeSub.style.display = "block"; document.getElementById("switch-subject-select").value = activeSubject;
    } else if (timerState === "BREAK") {
        badge.className = "badge badge-break"; badge.innerText = `ON BREAK: ${activeBreakReason}`;
        sessionLabel.innerText = "BREAK DURATION";
        btnStart.innerText = "Resume Study"; btnStart.style.display = "inline-block"; btnPause.style.display = "none"; btnBreak.style.display = "none"; btnStop.style.display = "inline-block"; changeSub.style.display = "none";
    } else {
        badge.className = "badge badge-idle"; badge.innerText = `STATUS: IDLE`;
        sessionLabel.innerText = "CURRENT SESSION";
        btnStart.innerText = "Start"; btnStart.style.display = "inline-block"; btnPause.style.display = "none"; btnBreak.style.display = "inline-block"; btnStop.style.display = "none"; changeSub.style.display = "none";
        // Grey out (rather than hide) Start/Break while another tab owns an
        // active session — the buttons stay visible so the note above them
        // makes sense, but clicking is disabled at the control level too,
        // not just guarded in the click handler.
        btnStart.disabled = !!otherLock; btnBreak.disabled = !!otherLock;
    }
}

export function updateLiveSummary() {
    let db = getDB();
    let day = db[getTodayKey()] || initToday();
    let liveStudySec = (timerState === "STUDYING") ? Math.floor(segmentElapsedMs / 1000) : 0;
    let liveBreakSec = (timerState === "BREAK") ? Math.floor(segmentElapsedMs / 1000) : 0;
    let studyTotal = day.totalStudy + liveStudySec;
    let breakTotal = day.totalBreak + liveBreakSec;
    document.getElementById("live-study-val").innerText = formatReadable(studyTotal);
    document.getElementById("live-break-val").innerText = formatReadable(breakTotal);
    let html = "";
    for (let [cat, sec] of Object.entries(day.subjects)) {
        let add = (timerState === "STUDYING" && activeSubject === cat) ? liveStudySec : 0;
        html += `<div class="stat-row"><span style="color:var(--muted);">${cat}:</span><strong>${formatReadable(sec + add)}</strong></div>`;
    }
    document.getElementById("live-subject-list").innerHTML = html;
}

document.addEventListener("visibilitychange", () => { if (document.hidden) flushAndRestartSegment(); });
// BUG FIX: was `commitActiveSegment()` — commits the segment but never
// restarts it (segmentStartWallMs stays at its old value). pagehide fires on
// real navigation/close (harmless either way, nothing runs after), but also
// fires in cases where the page context survives (e.g. bfcache) — if the
// user comes back to that same still-running tab, the next commit would
// recompute elapsed time from the stale pre-pagehide start and double-count
// everything already committed here. flushAndRestartSegment() commits AND
// calls startSegment() again, so the segment's baseline is always correct
// whether or not the page actually unloads. It also already guards for
// STUDYING/BREAK, so this is a strict improvement with no downside.
window.addEventListener("pagehide", () => { flushAndRestartSegment(); });

// BUG FIX: requestAnimationFrame callbacks stop being invoked at all while
// a tab is hidden (not just throttled — genuinely paused), and on top of
// that, Chrome/most browsers "freeze" an entire background tab (no timers
// of any kind run) after it's stayed hidden for a few minutes. Previously
// the on-screen timer just silently sat frozen until the next time the
// browser itself got around to resuming the rAF loop, which could visibly
// lag behind for a moment after switching back — reported as "timer
// latency"/the number looking wrong right after reopening the tab. This
// forces an immediate, one-off resync the INSTANT the tab becomes visible
// again: cancel whatever (possibly very stale) frame was still pending,
// then call tick() directly so the display jumps straight to the correct
// wall-clock-computed value on this very frame instead of waiting for the
// browser to get around to it. cancelAnimationFrame() first is required,
// not optional — without it this and the browser's own eventually-resumed
// frame would both be running tick()'s self-rescheduling loop at once,
// doubling (then quadrupling, ad infinitum) the update rate every time the
// tab was hidden and shown again.
document.addEventListener("visibilitychange", () => {
    if (!document.hidden && (timerState === "STUDYING" || timerState === "BREAK")) {
        cancelAnimationFrame(animFrame);
        tick();
    }
});

// ----------------- SCREEN WAKE LOCK -----------------
// Keeps the display from auto-locking while a study/break session is
// running (same idea as a video app staying awake during playback).
// Unsupported browsers (no navigator.wakeLock) just silently no-op —
// everything else keeps working exactly as before.
let wakeLockSentinel = null;

async function requestWakeLock() {
    if (!("wakeLock" in navigator) || wakeLockSentinel) return;
    try {
        wakeLockSentinel = await navigator.wakeLock.request("screen");
        wakeLockSentinel.addEventListener("release", () => { wakeLockSentinel = null; });
    } catch (e) {
        // Common causes: low battery mode, permissions policy, or the tab
        // was already hidden when requested — fail silently, no user-facing
        // error, the timer itself is unaffected either way.
        wakeLockSentinel = null;
    }
}

async function releaseWakeLock() {
    if (!wakeLockSentinel) return;
    try { await wakeLockSentinel.release(); } catch (e) {}
    wakeLockSentinel = null;
}

// The browser force-releases the wake lock whenever the tab is hidden
// (switch tabs, minimize, screen lock). If a session is still running when
// the user comes back, re-acquire it.
document.addEventListener("visibilitychange", () => {
    if (!document.hidden && (timerState === "STUDYING" || timerState === "BREAK")) requestWakeLock();
});
