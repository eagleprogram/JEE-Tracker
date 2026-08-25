// main.js – JEE Study Tracker v2.0
// Entry point. Imports every module, exposes every function the HTML's
// inline onclick/onchange handlers call onto `window` (ES module functions
// are not global by default), and replicates the original single-file
// version's window.onload initialization sequence exactly.

import { getTodayKey } from './utils.js';
import { getLastBackupAt, markBackupDone, resetAllData } from './storage.js';

import {
    openSubjectModal, cancelSubjectModal, confirmStartStudy,
    pauseStudy, resumeStudy, takeBreak, confirmBreakReasonModal, cancelBreakReasonModal,
    handleBreakReasonInputKeydown, handleBreakReasonCheckboxKeydown,
    changeSubjectMidSession, endDay,
    setCurrentDayKey, getPersistedDayKey, tryRestoreActiveSession, startAutosave,
    updateUIState, updateLiveSummary, flushAndRestartSegment
} from './timer.js';

import {
    showToast, closeSidebar, openSidebarPanel, checkDayRollover,
    renderQuoteOfDay, renderExamYearUI, setExamYear, tickCountdowns,
    deleteCookiesAndReload, toggleZenMode, exitZenMode,
    hideGuestSignInReminder, guestReminderIgnore, guestReminderSnooze,
    guestReminderSignInClicked, runBootSignInGate, forceMobileZoomReflow,
    initHolidayReference
} from './ui.js';

import {
    initPlannerCalendar, addTodo, renderSidebarTools, toggleTodo, deleteTodo,
    calShiftMonth, renderPlannerCalendar, openPlannerModal, closePlannerModal,
    addPlannerTask, togglePlannerTask, deletePlannerTask, renderPlannerTasks,
    openDatePicker, confirmCarryOverTodos, declineCarryOverTodos
} from './planner.js';

import {
    loadHistoryData, deleteSubjectEntry, deleteStudySessionEntry,
    deleteBreakEntry, deleteStudyLog, deleteBreakLog, addMissedBreak
} from './history.js';

import {
    saveSleepLog, toggleSleepHistory, deleteSleepLogEntry,
    renderSleepPendingBanner, cancelPendingSleepLog, closeAttendanceReminderModal,
    closeEveningAttendanceReminderModal, closeMorningTodoReminderModal
} from './sleep.js';

import {
    toggleSyllabusChapterExpand, toggleSyllabusTag, setSyllabusSubject,
    migrateSyllabusChapterRenames
} from './syllabus.js';

import {
    setMistakesView, setMistakesSubject, setMistakeSort, filterMistakeSearch,
    onAddSubjectChange, onAddChapterChange, saveAddMistake, renderMistakesTracker,
    exportAllMistakes
} from './mistakes.js';

import {
    renderMistakeTagPicker, toggleMistakeTag, addMockTestEntry,
    deleteMockTestEntry, viewMockFile, closeMockFileModal, renderMockTestList,
    downloadCurrentMockFile, exportAllMockTests
} from './mocktest.js';

import {
    loadYoutubeLink, toggleYtHistory, loadFromYtHistory, ytTogglePlay,
    ytSetVolume, ytToggleLoop, deleteYtHistoryEntry, toggleYtHistoryStar,
    ytClosePlayer, ytCycleSpeed, ytEditNowPlaying
} from './youtube.js';

import { renderGarden, renderHeatmap, renderTrendChart } from './charts.js';

import {
    openQuestionsModal, closeQuestionsModal, saveQuestionsSolved,
    backQuestionsModal, deleteQuestionsSolved, openTodayQuestionsModal, renderQuestionsWidget
} from './questions.js';

import { getWeekOffset, setWeekOffset, renderWeekNavUI } from './week-nav.js';

import {
    downloadDayLog, shareDayLog, sendReportViaEmail, downloadReport, shareReport
} from './reports.js';

import { exportDataJSON, importDataJSON } from './backup.js';

import {
    signInWithGoogle, signOutOfGoogle, pushToCloud, pullFromCloud,
    deleteCloudData, renderSyncUI, showPendingToastIfAny, resolveInitialAuthAndSync
} from './firebase-sync.js';

import {
    enableNotifications, saveNotifSettingsFromUI, renderNotifSettingsUI,
    updateNotifPermissionStatus, stopAlarmLoop
} from './notifications.js';

import {
    enableBackgroundPush, disableBackgroundPush, updatePushPermissionStatusUI,
    reregisterPushIfEnabled
} from './push-notifications.js';

// Week-nav: each of the Garden/Questions/Trend ‹ This Week › controls
// calls this with its OWN key ("garden" | "questions" | "trend") — see
// week-nav.js for the independent-per-widget offset state. Only the one
// widget that was clicked re-renders (and only its own nav control
// repaints); the other two are untouched.
const WEEK_NAV_RENDERERS = {
    garden: renderGarden,
    questions: renderQuestionsWidget,
    trend: renderTrendChart
};
function shiftViewWeek(key, delta) {
    let renderFn = WEEK_NAV_RENDERERS[key];
    if (!renderFn) return;
    setWeekOffset(key, getWeekOffset(key) + delta);
    renderFn();
    renderWeekNavUI(key);
}

// -----------------------------------------------------------------------
// EXPOSE EVERY FUNCTION THE HTML's INLINE onclick/onchange HANDLERS CALL.
// (ES module top-level functions are NOT global — this is required.)
// -----------------------------------------------------------------------
Object.assign(window, {
    // storage.js
    resetAllData,
    // timer.js
    openSubjectModal, cancelSubjectModal, confirmStartStudy,
    pauseStudy, resumeStudy, takeBreak, confirmBreakReasonModal, cancelBreakReasonModal,
    handleBreakReasonInputKeydown, handleBreakReasonCheckboxKeydown,
    changeSubjectMidSession, endDay,
    updateLiveSummary, flushAndRestartSegment,
    // ui.js
    showToast, closeSidebar, openSidebarPanel, checkDayRollover,
    renderQuoteOfDay, renderExamYearUI, setExamYear, tickCountdowns,
    deleteCookiesAndReload, toggleZenMode, exitZenMode,
    hideGuestSignInReminder, guestReminderIgnore, guestReminderSnooze,
    guestReminderSignInClicked,
    // planner.js
    addTodo, toggleTodo, deleteTodo, calShiftMonth, renderSidebarTools,
    renderPlannerCalendar, openPlannerModal, closePlannerModal,
    addPlannerTask, togglePlannerTask, deletePlannerTask, renderPlannerTasks,
    openDatePicker, confirmCarryOverTodos, declineCarryOverTodos,
    // charts.js
    renderGarden, renderHeatmap, renderTrendChart,
    // questions.js
    openQuestionsModal, closeQuestionsModal, saveQuestionsSolved,
    backQuestionsModal, deleteQuestionsSolved, openTodayQuestionsModal,
    // week-nav.js (shared Garden/Questions/Trend week control)
    shiftViewWeek,
    // history.js
    loadHistoryData, deleteSubjectEntry, deleteStudySessionEntry,
    deleteBreakEntry, deleteStudyLog, deleteBreakLog, addMissedBreak,
    // sleep.js
    saveSleepLog, toggleSleepHistory, deleteSleepLogEntry, cancelPendingSleepLog,
    closeAttendanceReminderModal, closeEveningAttendanceReminderModal,
    closeMorningTodoReminderModal,
    // syllabus.js
    toggleSyllabusChapterExpand, toggleSyllabusTag, setSyllabusSubject,
    // mistakes.js
    setMistakesView, setMistakesSubject, setMistakeSort, filterMistakeSearch,
    onAddSubjectChange, onAddChapterChange, saveAddMistake, renderMistakesTracker,
    exportAllMistakes,
    // mocktest.js
    toggleMistakeTag, addMockTestEntry, deleteMockTestEntry, viewMockFile,
    closeMockFileModal, renderMockTestList, downloadCurrentMockFile, exportAllMockTests,
    // youtube.js
    loadYoutubeLink, toggleYtHistory, loadFromYtHistory, ytTogglePlay,
    ytSetVolume, ytToggleLoop, deleteYtHistoryEntry, toggleYtHistoryStar,
    ytClosePlayer, ytCycleSpeed, ytEditNowPlaying,
    // reports.js
    downloadDayLog, shareDayLog, sendReportViaEmail, downloadReport, shareReport,
    // backup.js
    exportDataJSON, importDataJSON,
    // firebase-sync.js
    signInWithGoogle, signOutOfGoogle, pushToCloud, pullFromCloud,
    deleteCloudData,
    // notifications.js
    enableNotifications, saveNotifSettingsFromUI, stopAlarmLoop,
    // push-notifications.js
    enableBackgroundPush, disableBackgroundPush
});

// -----------------------------------------------------------------------
// INITIALIZATION SEQUENCE (replaces the original single-file window.onload)
// NOTE: a <script type="module"> runs after the document has finished
// parsing (it behaves like `defer`), so the DOM is already ready here —
// no DOMContentLoaded listener needed (and one added here could fire too
// late, since the event may already have passed by the time this module
// finishes loading and evaluates).
// -----------------------------------------------------------------------
// The cache-busted reload in ui.js's deleteCookiesAndReload() navigates to
// a URL with a ?_cb=<timestamp> param tacked on — that's the only way to
// force a real network fetch instead of a stale disk-cache hit (see that
// function's own comment for why a plain reload isn't enough). But it's a
// one-time internal trick, not something that should stick around visibly
// in the address bar afterwards, or look like a "different" URL to the
// user. history.replaceState() strips it back to the clean URL in place —
// no navigation, no reload, nothing re-fetched — it just fixes what's
// displayed. This has to run before anything below touches the DOM/URL, so
// it's the very first thing initApp() does.
function stripCacheBustParam() {
    if (!location.search.includes("_cb=")) return;
    let url = new URL(location.href);
    url.searchParams.delete("_cb");
    history.replaceState(null, "", url.pathname + (url.search ? url.search : "") + url.hash);
}

async function initApp() {
    stripCacheBustParam();
    setCurrentDayKey(getPersistedDayKey());

    // Redeem any toast that was queued right before a reload triggered by
    // cloud auto-load or the real-time sync listener — see
    // showPendingToastIfAny()'s own comment in firebase-sync.js for why
    // that can't just call showToast() directly before reloading.
    showPendingToastIfAny();

    // BUG FIX: resolve sign-in state — and let any pending cloud auto-load
    // finish (or trigger its own reload) — BEFORE any local data is
    // rendered or mutated below. See resolveInitialAuthAndSync()'s own
    // comment in firebase-sync.js for the full story: skipping this used to
    // let checkDayRollover()'s todo-carryover dialog run and mutate local
    // data while a cloud pull was still in flight, and the cloud pull would
    // then silently overwrite (and reload away) whatever was just approved.
    // For the normal case (already synced, or guest/offline) this resolves
    // near-instantly and boot proceeds exactly as before. If an auto-load
    // DOES end up happening, it triggers its own location.reload() — this
    // await simply never gets past that point, and the reload boots a fresh
    // instance of the app with the correctly-merged local data instead.
    await resolveInitialAuthAndSync();

    // BUG FIX: sign-in must be resolved (signed in, "Ignore for Today", or
    // "Remind Later") BEFORE anything else below runs — day rollover's
    // todo-carryover confirm() dialog, notification/alarm checks, planner
    // rendering, all of it. Previously the sign-in reminder only appeared
    // ~1.5s after sign-out was detected, fully independent of this boot
    // sequence, so it could show up mid-way through (or after) all of the
    // above — reported as "the to-do transfer dialog came, I accepted it,
    // then sign-in came and everything went away." Awaiting this here makes
    // the sign-in prompt the very first thing a guest/signed-out user sees,
    // and guarantees nothing else touches local data until they've made a
    // choice. Already-signed-in users resolve this instantly (see
    // runBootSignInGate()'s own comment in ui.js).
    await runBootSignInGate();

    // One-time migration for the just-renamed/split syllabus chapters —
    // must run before the syllabus tab could possibly be rendered.
    migrateSyllabusChapterRenames();

    // History date picker: default to today, cap at today.
    let historyPicker = document.getElementById("history-picker");
    historyPicker.value = getTodayKey();
    historyPicker.setAttribute("max", getTodayKey());
    loadHistoryData();

    // Mock-test date picker: cap at today too — a mock test can't have been
    // taken on a date that hasn't happened yet.
    document.getElementById("mock-date-input").setAttribute("max", getTodayKey());

    // Timer: resume an in-progress session if the tab was closed mid-session.
    tryRestoreActiveSession();
    updateUIState();
    updateLiveSummary();
    startAutosave();

    // Sidebar tools.
    // initPlannerCalendar() must run before tickCountdowns() below —
    // checkDayRollover() (called from inside tickCountdowns) can now call
    // renderPlannerCalendar() on the very first tick if a day actually
    // rolled over while the app was closed (see the setCurrentDayKey fix
    // in timer.js), and that needs calViewYear/calViewMonth set first.
    initPlannerCalendar();
    renderSidebarTools();
    renderMistakeTagPicker();
    renderSleepPendingBanner();
    renderNotifSettingsUI();
    updateNotifPermissionStatus();

    // Header / quote / countdowns.
    renderQuoteOfDay();
    renderExamYearUI();
    tickCountdowns();                 // also runs checkDayRollover + notif checks + renderGarden
    setInterval(tickCountdowns, 1000);
    // Catch-up on visibility regain: background/hidden tabs get their
    // setInterval throttled by the browser (Chrome limits hidden tabs to
    // roughly one timer wakeup per minute, sometimes coarser), which is why
    // time-of-day reminders (revision, parent log, planner, sleep) could
    // sit silently overdue while the tab sat unfocused and only catch up
    // whenever the next throttled tick happened to land. Firing an extra
    // tick the instant the tab becomes visible again closes that gap
    // immediately instead of waiting up to a minute (or more) for it.
    document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "visible") tickCountdowns();
    });

    // Charts.
    renderHeatmap();
    renderTrendChart();
    renderQuestionsWidget();
    renderWeekNavUI();

    // Seed the backup-reminder timestamp on first run so it has a baseline.
    if (!getLastBackupAt()) markBackupDone();

    // Cloud sync: auth was already resolved by resolveInitialAuthAndSync()
    // above (which also called initFirebaseAuthIfNeeded() internally, wiring
    // up the listener for any LATER sign-in/out this session) — just paint
    // the signed-in/out UI to match the final state now.
    renderSyncUI();

    // Background push (Firebase Cloud Messaging): paint current status, and
    // silently re-register this device's token if it was already enabled
    // before (see reregisterPushIfEnabled()'s own comment in
    // push-notifications.js for why). Fire-and-forget — never blocks boot,
    // and fails silently (logged, not surfaced) if push isn't configured on
    // this deployment yet.
    updatePushPermissionStatusUI();
    reregisterPushIfEnabled();

    // PWA offline support.
    if ("serviceWorker" in navigator) {
        navigator.serviceWorker.register("./sw.js").catch(err => {
            console.error("Service worker registration failed:", err);
        });
    }

    // Mobile "zoomed out" default density: nudge it into actually applying
    // on this cold load — see forceMobileZoomReflow()'s own comment in
    // ui.js for why this is needed at all. Called here so it runs once all
    // of the above has finished injecting/resizing DOM content.
    forceMobileZoomReflow();
}

initApp();

// Extra safety net for the same cold-start zoom issue, independent of the
// initApp() call above: the `load` event fires after every resource
// (fonts, images) has finished, which can itself be a later reflow trigger
// than anything inside initApp() — and `pageshow` additionally covers a PWA
// being resumed from the OS/back-forward cache rather than freshly loaded,
// which is another path the person described as "opens or refreshes the
// app" that a plain `load` listener alone wouldn't catch.
window.addEventListener("load", forceMobileZoomReflow);
window.addEventListener("pageshow", forceMobileZoomReflow);

// Holiday Reference (Google Calendar embed): deferred until every other
// page resource has finished loading — see initHolidayReference()'s own
// comment in ui.js for why this fixes the "broken until refresh on
// mobile" bug.
window.addEventListener("load", initHolidayReference);
