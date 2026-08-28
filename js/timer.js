import { formatHMS, formatReadable, dateKeyFromWall, getTodayKey, generateId, stampTime12Hour } from './utils.js';
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
import { enterZenMode, exitZenMode, lockBodyScroll, unlockBodyScroll } from './ui.js';
// Forward reference, same circular-import pattern as ui.js above (safe —
// only called inside function bodies below, never at module-eval time).
// Starts the water-break reminder the moment a study session actually
// begins; it keeps running until the night's sleep log is saved (see
// stopWaterReminder() in sleep.js) — including through breaks now (see
// confirmBreakReasonModal() below), since it's no longer force-stopped on
// break start. beginBreakAlarmSuppression()/endBreakAlarmSuppression() mute
// (and later release) every non-critical reminder — water included — during
// a large/meal-type break.
import { startWaterReminder, beginBreakAlarmSuppression, endBreakAlarmSuppression } from './notifications.js';

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
// BUG FIX: BREAK DURATION (the big blue "session-timer" digits while on a
// break) used to be driven purely by segmentElapsedMs — the elapsed time
// since the CURRENT segment started. commitActiveSegment()+startSegment()
// run every 20s (the autosave interval, see startAutosave()) and on every
// tab-hide/pagehide (see flushAndRestartSegment()), and each of those
// resets segmentStartWallMs. STUDYING already had its own running total
// (sessionStudySec, above) that survives those restarts, but BREAK had no
// equivalent — so the on-screen break timer visibly snapped back down
// (e.g. from ~20s to ~0s) every time an autosave/tab-hide restart fired,
// while "Total Breaks" in Today's Live Summary (built from the DB total +
// live segment, not from the display timer) kept counting correctly. That
// mismatch is exactly what was reported: the small "Total Breaks" figure
// staying accurate while the big break timer lagged/jumped after switching
// tabs or apps. sessionBreakSec mirrors sessionStudySec for BREAK so the
// on-screen timer and the live summary always agree.
let sessionBreakSec = 0;
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
// Whether the CURRENT break is a "large" one (meal/sleep-type — auto-
// detected by keyword, or explicitly checked) whose alarms are being
// muted until it ends — see takeBreak()/confirmBreakReasonModal() below.
let activeBreakIsLarge = false;
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
// BUG FIX: this used to be 9000 (3x the heartbeat interval), sized only for
// the case of a slow/delayed tick. It didn't account for real Chrome/Edge
// background-tab timer throttling: once the OWNING tab (the one actually
// running the session) is backgrounded — which is the normal case, since
// the whole point of this lock is to be checked FROM a different, focused
// tab — the browser is allowed to delay its setInterval heartbeat well past
// a few seconds (and after ~5 minutes hidden, "intensive throttling" can
// push it out to roughly once a minute). With a 9s staleness window, any
// owning tab that had been backgrounded for a while looked "dead" to every
// other tab long before it actually was, which is exactly the reported bug:
// the "active session running in another tab" warning would incorrectly
// clear itself (readable as stale) even though that other tab's session was
// still genuinely running. 65s comfortably clears the worst-case throttled
// gap. This only affects how long a truly CRASHED/force-closed tab's lock
// lingers before another tab can start fresh — a clean close/refresh/
// navigation already releases the lock instantly via the 'pagehide' handler
// below, without waiting on staleness at all.
const LOCK_STALE_MS = 65000;

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
// BUG FIX: this used to be `setInterval(writeSessionLockHeartbeat, ...)`
// alone. writeSessionLockHeartbeat() only ever WRITES this tab's own lock
// state — it never re-renders the "active session running in another tab"
// banner/disabled buttons on an idle tab. That banner was only ever
// refreshed by the 'storage' event below, which fires ONLY when the OTHER
// tab actively writes a new value (a live heartbeat tick, or its own clean
// close clearing the key). If that other tab stopped writing without a
// clean close (backgrounded long enough to get throttled — see
// LOCK_STALE_MS above — or genuinely crashed/force-quit), no further
// 'storage' event ever fires here, so this tab's banner and greyed-out
// Start/Break buttons stayed stuck showing "active session elsewhere"
// indefinitely, long after the lock had actually gone stale — the exact
// reported symptom of the warning only clearing itself after a manual
// refresh. Reusing this same interval to re-check and re-render while IDLE
// means the banner now self-corrects on its own within one heartbeat tick
// of the lock actually going stale, no refresh needed.
setInterval(() => {
    writeSessionLockHeartbeat();
    if (timerState === "IDLE") updateUIState();
}, LOCK_HEARTBEAT_MS);

// 'storage' fires in every OTHER tab (never the tab that made the change)
// the instant the lock key changes — lets a second, otherwise-idle tab
// react immediately (grey out/re-enable Start & Break) instead of waiting
// on its own next heartbeat tick. The interval above is the fallback for
// when no such write ever arrives (see BUG FIX above it).
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
    // BUG FIX: writeSessionLockHeartbeat() (below) previously only ran on
    // its own setInterval tick, which doesn't fire until LOCK_HEARTBEAT_MS
    // (3s) after the page loaded — NOT the moment a session actually
    // starts. A session started right after page load (very common — Start
    // is often the very first click) left up to a 3s window where
    // SESSION_LOCK_KEY hadn't been written at all yet, so a second tab
    // opened in that exact window saw no lock and could start its own
    // session too — exactly the double-counting this lock exists to
    // prevent. Writing the heartbeat immediately here, at every segment
    // start (fresh start, resume, break, subject switch, autosave/pagehide
    // restart, tab-restore), closes that gap; the periodic interval below
    // just keeps it refreshed after.
    writeSessionLockHeartbeat();
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
    let committedBreakSecThisCall = 0;
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
            // BUG FIX: this used to stamp every log entry with chunkEnd — the
            // wall-clock time at the moment this particular commit fired
            // (every 20s autosave, every tab-hide, every pause/break/subject
            // switch). Since existing.time was then overwritten on every
            // later commit that extended the same entry, the displayed time
            // kept creeping forward for as long as the study/break ran (e.g.
            // a break started at 4:00 PM and still going at 4:20 PM would
            // show "4:20 PM", not the actual start time) — reported as
            // logs taking the "output"/end time instead of the input/start
            // time. Logs should show when the user actually started that
            // study/break segment and never drift afterward. Stamping with
            // cursor (this chunk's START, not its end) and never touching
            // existing.time again on later commits fixes both: a same-day
            // entry gets its true start time once, and only its duration
            // grows after that.
            let stamp = stampTime12Hour(new Date(cursor));
            if (timerState === "STUDYING") {
                day.subjects[activeSubject] = (day.subjects[activeSubject] || 0) + chunkSec;
                day.totalStudy += chunkSec;
                committedStudySecThisCall += chunkSec;
                let ref = openEntryRefs[refKey];
                let existing = ref ? day.studySessions.find(s => s.id === ref.id) : null;
                if (existing && existing.subject === activeSubject) {
                    existing.duration += chunkSec;
                } else {
                    let newEntry = { id: generateId(), time: stamp, subject: activeSubject, duration: chunkSec };
                    day.studySessions.push(newEntry);
                    openEntryRefs[refKey] = { id: newEntry.id };
                }
            } else if (timerState === "BREAK") {
                day.totalBreak += chunkSec;
                committedBreakSecThisCall += chunkSec;
                let ref = openEntryRefs[refKey];
                let existing = ref ? day.breaks.find(b => b.id === ref.id) : null;
                if (existing) {
                    existing.duration += chunkSec;
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
    else if (timerState === "BREAK") sessionBreakSec += committedBreakSecThisCall;
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
        saveActiveSessionRaw({ state: timerState, activeSubject, activeBreakReason, segmentStartWallMs, sessionStudySec, sessionBreakSec, dayKey: currentDayKey });
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
        timerState = snap.state; activeSubject = snap.activeSubject; activeBreakReason = snap.activeBreakReason; sessionStudySec = snap.sessionStudySec || 0; sessionBreakSec = snap.sessionBreakSec || 0; currentSegmentId++; startSegment(); updateUIState(); tick();
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
    // BUG FIX: this used to unconditionally reset the segment on every call.
    // A stray SECOND call while already STUDYING (a double-tap on touch,
    // a duplicate/stuck event listener) would call startSegment() again,
    // which resets segmentStartWallMs to "now" WITHOUT first banking
    // whatever time had already elapsed since the last commit — silently
    // discarding it (never logged, just gone). This can't happen via a
    // single normal click (the flows that reach here — fresh IDLE start,
    // or BREAK -> Start — always arrive with timerState something other
    // than STUDYING), so guarding on that exact state is a safe, purely
    // defensive no-op for every real transition already in use.
    if (timerState === "STUDYING") return;
    // Captured before timerState changes below — needed to know whether
    // this is genuinely "Resume Study after a break" (the moment a large
    // break's muted alarms should come back) vs a fresh IDLE start.
    let wasOnBreak = (timerState === "BREAK");
    activeSubject = document.getElementById("modal-subject-select").value;
    document.getElementById("subject-modal").style.display = "none";
    unlockBodyScroll(); // release the modal's own lock — enterZenMode() below takes its own
    timerState = "STUDYING"; currentSegmentId++; startSegment();
    updateUIState(); tick();
    // Fresh study start (main-page Start button, or Resume Study after a
    // break — both route through here) always drops straight into Zen Mode,
    // whether or not the user touched the dedicated zen toggle themselves.
    enterZenMode();
    startWaterReminder();
    // Feature request: "Resume Study" is one of the two ways a break
    // actually ends (the other is End Session — see endDay() below) — release
    // anything a large/meal-type break was muting the instant this happens.
    if (wasOnBreak && activeBreakIsLarge) endBreakAlarmSuppression();
    activeBreakIsLarge = false;
}

export function pauseStudy() { commitActiveSegment(); cancelAnimationFrame(animFrame); timerState = "PAUSED"; clearActiveSession(); updateUIState(); }

export function resumeStudy() {
    // BUG FIX: same class of issue as confirmStartStudy() above — a stray
    // second call while already STUDYING would silently drop already-
    // elapsed, uncommitted time by resetting segmentStartWallMs without
    // banking it first. resumeStudy() is only ever reached from PAUSED in
    // the real UI, so this guard is a no-op on every legitimate path.
    if (timerState === "STUDYING") return;
    timerState = "STUDYING"; currentSegmentId++; startSegment(); updateUIState(); tick();
    // "Resume" from PAUSED also counts as (re)starting a study session — same
    // auto-zen behavior as confirmStartStudy() above.
    enterZenMode();
    startWaterReminder();
}

// Captured by takeBreak() below, read by confirmBreakReasonModal()/
// cancelBreakReasonModal() once the user actually responds — a real modal
// is asynchronous (unlike the old window.prompt(), which blocked JS
// execution until dismissed), so this can't just be a local variable
// inside takeBreak() anymore; it has to survive until the next click.
let breakModalPreviousState = null;

// Feature request: auto-detect a "large" (meal/sleep-type) break from
// whatever the user types as the reason, so breakfast/lunch/dinner/a nap
// don't need the explicit checkbox every time — see the break-reason-modal
// checkbox in index.html for the manual override, and
// beginBreakAlarmSuppression()/endBreakAlarmSuppression() in notifications.js
// for what "large" actually does (mutes every non-critical reminder until
// the break ends). Matched word-by-word, tolerant of small typos (a letter
// swapped/dropped/added) via Levenshtein distance — "brekfast" or "diner"
// still count, not just exact spelling.
const LARGE_BREAK_KEYWORDS = ["dinner", "breakfast", "lunch", "sleep", "nap"];

// Feature request: everything that ISN'T study is logged as some kind of
// break (bathing, a walk, tea, a phone call, the gym...), so typo-correct
// these common ones too — same spelling-fix treatment as the large-break
// keywords above, just without flipping the "long break" checkbox, since
// these are normally short. Add more words here any time a new common
// break name comes up.
const COMMON_BREAK_KEYWORDS = ["bath", "bathroom", "washroom", "toilet", "walk", "water", "snack", "tea", "coffee", "gym", "exercise", "phone", "call", "rest", "shower", "prayer", "meditation"];

// Every keyword eligible for spelling-correction — large-break keywords
// still get the checkbox auto-checked (see isLarge below), common ones
// just get their spelling fixed.
const ALL_BREAK_KEYWORDS = LARGE_BREAK_KEYWORDS.concat(COMMON_BREAK_KEYWORDS);

// Plain Levenshtein edit distance — small inputs only (single words), so
// no need for anything fancier than the textbook O(m*n) DP table.
function levenshteinDistance(a, b) {
    let m = a.length, n = b.length;
    let dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
    for (let i = 0; i <= m; i++) dp[i][0] = i;
    for (let j = 0; j <= n; j++) dp[0][j] = j;
    for (let i = 1; i <= m; i++) {
        for (let j = 1; j <= n; j++) {
            dp[i][j] = a[i - 1] === b[j - 1] ? dp[i - 1][j - 1] : 1 + Math.min(dp[i - 1][j - 1], dp[i - 1][j], dp[i][j - 1]);
        }
    }
    return dp[m][n];
}
function looksLikeLargeBreak(reason) {
    let words = (reason || "").toLowerCase().match(/[a-z]+/g) || [];
    for (let w of words) {
        for (let k of LARGE_BREAK_KEYWORDS) {
            if (w === k) return true;
            // Typo tolerance: 1 edit for short keywords (nap), 2 for longer
            // ones (breakfast) — loose enough to catch a swapped/missing
            // letter, tight enough that unrelated short words ("map",
            // "cap") don't accidentally match "nap".
            let maxDist = k.length <= 4 ? 1 : 2;
            if (Math.abs(w.length - k.length) <= maxDist && levenshteinDistance(w, k) <= maxDist) return true;
        }
    }
    return false;
}

// BUG FIX: the per-word correction pass below only ever looked at ONE
// token at a time, so a keyword typed as two separate words (e.g. "brek
// fast" instead of "breakfast") never matched anything — neither "brek"
// nor "fast" is close enough to a whole keyword by itself. This pass runs
// first and looks at every adjacent word-pair joined together (ignoring
// the space between them); if THAT combined string is a close match for a
// keyword, it collapses the pair into the single canonical word. Runs in a
// loop since splice() shifts indices — simplest correct way to handle more
// than one split pair in the same input is to rescan from scratch after
// each merge (break-reason text is a few words at most, so this is cheap).
function mergeSplitBreakWords(tokens) {
    for (let i = 0; i < tokens.length - 2; i++) {
        let a = tokens[i], ws = tokens[i + 1], b = tokens[i + 2];
        if (!/^[a-zA-Z]+$/.test(a) || !/^[a-zA-Z]+$/.test(b)) continue;
        if (!/^\s+$/.test(ws || "")) continue; // only a single run of whitespace between them
        let merged = (a + b).toLowerCase();
        for (let k of ALL_BREAK_KEYWORDS) {
            let maxDist = k.length <= 4 ? 1 : 2;
            if (merged === k || (Math.abs(merged.length - k.length) <= maxDist && levenshteinDistance(merged, k) <= maxDist)) {
                tokens[i] = k;
                tokens.splice(i + 1, 2); // drop the whitespace token and the now-absorbed second word
                return true; // caller reruns this on the updated tokens to catch any further splits
            }
        }
    }
    return false;
}

// Feature request: don't just silently DETECT a typo'd keyword at submit
// time — visibly rewrite it to the correct spelling in the input itself
// (e.g. "LNCH" → "lunch"), and check the long-break box live, right as the
// correction happens, instead of only reflecting it once the break has
// already started. Splits on whitespace so only the mistyped WORD gets
// replaced, not the whole field. Called on every "did the user just finish
// typing something" moment (Enter, blur, and defensively again right
// before the break actually starts) rather than on every keystroke — a
// live-as-you-type version would fight a still half-typed word (e.g.
// correcting "lun" into an unrelated keyword before "lunch" is finished).
function autoCorrectBreakReasonInput() {
    let input = document.getElementById("break-reason-input");
    let box = document.getElementById("break-reason-large-toggle");
    if (!input) return;
    let tokens = input.value.split(/(\s+)/); // keeps whitespace runs as their own tokens for reassembly
    let rewritten = false, isLarge = false;
    // Pass 1: collapse any keyword that got typed as two separate words
    // ("brek fast" -> "breakfast") before looking at single words at all.
    while (mergeSplitBreakWords(tokens)) rewritten = true;
    // Pass 2: per-word typo correction, same as before, now checked
    // against every common break name (not just the "large" ones) — the
    // long-break checkbox only gets auto-checked for an actual large-break
    // keyword match, never for a plain common one like "walk" or "tea".
    for (let i = 0; i < tokens.length; i++) {
        let raw = tokens[i];
        if (!/[a-zA-Z]/.test(raw)) continue; // whitespace-only token — nothing to check
        let lower = raw.toLowerCase();
        for (let k of ALL_BREAK_KEYWORDS) {
            let maxDist = k.length <= 4 ? 1 : 2;
            if (lower === k || (Math.abs(lower.length - k.length) <= maxDist && levenshteinDistance(lower, k) <= maxDist)) {
                if (lower !== k) { tokens[i] = k; rewritten = true; } // rewrite in place to the canonical spelling
                if (LARGE_BREAK_KEYWORDS.includes(k)) isLarge = true;
                break;
            }
        }
    }
    if (rewritten) input.value = tokens.join("");
    if (isLarge && box) box.checked = true;
}

export function takeBreak() {
    // takeBreak() is reachable directly from IDLE (the Break button stays
    // visible there — see index.html), so a fresh break needs the same
    // cross-tab check as a fresh Start. Coming from STUDYING/PAUSED, this
    // tab already owns the session, so no check needed there.
    if (timerState === "IDLE" && blockedByOtherTab()) return;
    // Captured before commitActiveSegment()/the modal can change anything,
    // so a Cancel below knows exactly what state to resume.
    breakModalPreviousState = timerState;
    commitActiveSegment(); cancelAnimationFrame(animFrame);
    // BUG FIX / ENHANCEMENT: this used to be a plain window.prompt() for the
    // break reason — a native prompt can't hold a checkbox, so there was no
    // way to explicitly mark a break as a large/meal-type one. Replaced with
    // a real modal (break-reason-modal in index.html) carrying the same text
    // field plus a "This is a long break" checkbox.
    document.getElementById("break-reason-input").value = "";
    document.getElementById("break-reason-large-toggle").checked = false;
    document.getElementById("break-reason-modal").style.display = "flex";
    lockBodyScroll();
    setTimeout(() => { let inp = document.getElementById("break-reason-input"); if (inp) inp.focus(); }, 50);
}

// Feature request: Enter in the text field moves focus to the checkbox
// (instead of doing nothing/submitting a nonexistent form); Enter on the
// checkbox checks it first, then a second Enter actually starts the break —
// a fully keyboard-driven path through the whole modal, no mouse needed.
// Also runs the typo auto-correct (see autoCorrectBreakReasonInput() above)
// right as the user finishes typing (Enter) — same trigger point as
// handleBreakReasonInputBlur() below for the mouse-driven path.
export function handleBreakReasonInputKeydown(e) {
    if (e.key !== "Enter") return;
    e.preventDefault();
    autoCorrectBreakReasonInput();
    let box = document.getElementById("break-reason-large-toggle");
    if (box) box.focus();
}
// Covers the mouse-driven path (typing, then clicking "Start Break" or the
// checkbox directly without ever pressing Enter) — blur fires the instant
// focus leaves the text field either way.
export function handleBreakReasonInputBlur() {
    autoCorrectBreakReasonInput();
}
export function handleBreakReasonCheckboxKeydown(e) {
    if (e.key !== "Enter") return;
    e.preventDefault();
    let box = document.getElementById("break-reason-large-toggle");
    if (!box) return;
    if (!box.checked) { box.checked = true; return; }
    confirmBreakReasonModal();
}

// "Start Break" in the modal — equivalent to the old prompt()'s OK path.
// An empty field still starts the break with the same "Short Break"
// default the old prompt() used.
export function confirmBreakReasonModal() {
    // Defensive re-run — Enter/blur above already cover typing then Enter
    // or typing then clicking elsewhere, but this catches any path that
    // somehow reaches here without either firing first.
    autoCorrectBreakReasonInput();
    let reason = document.getElementById("break-reason-input").value;
    let manualLargeToggle = document.getElementById("break-reason-large-toggle").checked;
    document.getElementById("break-reason-modal").style.display = "none";
    unlockBodyScroll();
    if (!reason || !reason.trim()) reason = "Short Break";
    activeBreakReason = reason.trim();
    activeBreakIsLarge = manualLargeToggle || looksLikeLargeBreak(activeBreakReason);
    // Fresh break (as opposed to the same break resuming after an autosave/
    // tab-hide restart, which goes through flushAndRestartSegment() instead
    // and never calls takeBreak() again) — reset the break session total so
    // BREAK DURATION starts counting this break from zero.
    sessionBreakSec = 0;
    timerState = "BREAK"; currentSegmentId++; startSegment();
    updateUIState(); tick();
    // Feature request (refined): the water reminder keeps running through
    // the break now, same as every other reminder — it's no longer force-
    // stopped here. If this break isn't "large", it still pings on its
    // normal schedule (matches a short break rarely being long enough to
    // matter). If it IS large, its notify() call (priority 6, no bypass)
    // gets captured by the SAME suppression queue as everything else and
    // only actually rings once Resume Study/End Session is clicked — see
    // beginBreakAlarmSuppression() in notifications.js.
    // Large/meal-type break: mute every non-critical reminder until this
    // break actually ends (see the endBreakAlarmSuppression() calls in
    // confirmStartStudy()/endDay() below). Break-overrun still rings
    // through regardless — see notify()'s bypassSuppression in notifications.js.
    if (activeBreakIsLarge) beginBreakAlarmSuppression();
    // Break now drops into Zen Mode exactly like a fresh study start
    // (confirmStartStudy()/resumeStudy() above do the same thing). The zen
    // visuals in components.css key off body.zen-mode only, not timerState,
    // so they render identically for a break as they do while studying —
    // no separate CSS was needed for this.
    enterZenMode();
}

// "Cancel" in the break-reason modal — equivalent to the old prompt()'s
// Cancel/Esc path. On Cancel from STUDYING, the segment was already
// committed and its tick loop stopped in takeBreak() above; restart both
// so the study session keeps running exactly as if Break had never been
// clicked. From PAUSED/IDLE nothing was ticking yet (commitActiveSegment()
// is a no-op in those states), so there's nothing to restart — just leave
// state unchanged.
export function cancelBreakReasonModal() {
    document.getElementById("break-reason-modal").style.display = "none";
    unlockBodyScroll();
    if (breakModalPreviousState === "STUDYING") { startSegment(); tick(); }
    breakModalPreviousState = null;
}

export function changeSubjectMidSession() { activeSubject = document.getElementById("switch-subject-select").value; updateLiveSummary(); }

export function endDay() {
    // Captured before timerState changes below — same "did a break just
    // end" check as confirmStartStudy() above; End Session is the other of
    // the two ways a break can end.
    let wasOnBreak = (timerState === "BREAK");
    commitActiveSegment(); cancelAnimationFrame(animFrame);
    timerState = "IDLE"; segmentElapsedMs = 0; sessionStudySec = 0; sessionBreakSec = 0; carryMs = 0; clearActiveSession();
    if (wasOnBreak && activeBreakIsLarge) endBreakAlarmSuppression();
    activeBreakIsLarge = false;
    // BUG FIX: release this tab's session lock immediately instead of
    // waiting up to LOCK_HEARTBEAT_MS (3s) for the next heartbeat tick to
    // notice timerState is now IDLE. Without this, a second tab opened in
    // that few-second gap right after End Day would still see a "fresh"
    // lock and wrongly report a session as still running here. Only ever
    // clears a lock this tab itself owns, same guard as everywhere else.
    let endDayLock = readSessionLock();
    if (endDayLock && endDayLock.tabId === getTabId()) clearRawFlag(SESSION_LOCK_KEY);
    // BUG FIX: End Day used to leave Zen Mode's overlay/backdrop on screen if
    // the user hit the red "End Day" button while zen'd in (reachable during
    // both STUDYING and BREAK — see index.html). exitZenMode() itself is a
    // safe no-op when zen mode isn't active, so this is safe to call
    // unconditionally on every End Day, not just the zen'd-in case.
    exitZenMode();
    updateUIState();
    document.getElementById("session-timer").innerText = "00:00:00";
    updateLiveSummary(); loadHistoryData(); renderGarden(); renderHeatmap(); renderTrendChart();
}

export function tick() {
    // Same wall-clock fix as commitActiveSegment() above — see its comment.
    segmentElapsedMs = Date.now() - segmentStartWallMs;
    if (timerState === "STUDYING") document.getElementById("session-timer").innerText = formatHMS(sessionStudySec * 1000 + segmentElapsedMs);
    else if (timerState === "BREAK") document.getElementById("session-timer").innerText = formatHMS(sessionBreakSec * 1000 + segmentElapsedMs);
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
window.addEventListener("pagehide", (e) => {
    flushAndRestartSegment();
    // BUG FIX: releases THIS tab's cross-tab session lock (SESSION_LOCK_KEY,
    // above) the instant the tab is genuinely closed or navigated away from.
    // e.persisted === true means the browser may restore this exact page
    // from bfcache later (the session is still "live" in memory, so the
    // lock must stay held); only a real close/unload (persisted === false)
    // releases it. Previously the lock was only ever cleared by the next
    // heartbeat tick seeing timerState go back to IDLE — which never
    // happens on a hard close, since all JS simply stops running. The lock
    // then just sat there, still looking "fresh" for up to LOCK_STALE_MS
    // (9s), because its last-written timestamp was never updated again.
    // Reopening the app inside that window (Ctrl+Shift+T, History) read
    // that stale-but-not-yet-expired lock, saw a tabId that didn't match
    // this new load's own sessionStorage-based tabId, and showed the false
    // "Active session running in another tab" warning with Start/Break
    // disabled — even though no other tab was actually running anything.
    // Clearing it here removes that window entirely. This only ever clears
    // a lock this tab itself owns (never another still-open tab's), so the
    // original double-counting protection between two genuinely live tabs
    // is completely unaffected.
    if (!e.persisted) {
        let lock = readSessionLock();
        if (lock && lock.tabId === getTabId()) clearRawFlag(SESSION_LOCK_KEY);
    }
});

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