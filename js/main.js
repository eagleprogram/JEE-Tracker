// main.js – JEE Study Tracker v2.0
// Entry point. Imports every module, exposes every function the HTML's
// inline onclick/onchange handlers call onto `window` (ES module functions
// are not global by default), and replicates the original single-file
// version's window.onload initialization sequence exactly.

import { getTodayKey } from './utils.js';
import { getLastBackupAt, markBackupDone, resetAllData } from './storage.js';

import {
    openSubjectModal, cancelSubjectModal, confirmStartStudy,
    pauseStudy, resumeStudy, takeBreak, changeSubjectMidSession, endDay,
    setCurrentDayKey, tryRestoreActiveSession, startAutosave,
    updateUIState, updateLiveSummary, flushAndRestartSegment
} from './timer.js';

import {
    showToast, closeSidebar, openSidebarPanel, checkDayRollover,
    renderQuoteOfDay, renderExamYearUI, setExamYear, tickCountdowns,
    clearCacheAndReload
} from './ui.js';

import {
    initPlannerCalendar, addTodo, renderSidebarTools, toggleTodo, deleteTodo,
    calShiftMonth, renderPlannerCalendar, openPlannerModal, closePlannerModal,
    addPlannerTask, togglePlannerTask, deletePlannerTask, renderPlannerTasks,
    openDatePicker
} from './planner.js';

import {
    loadHistoryData, deleteSubjectEntry, deleteStudySessionEntry,
    deleteBreakEntry, deleteStudyLog, deleteBreakLog
} from './history.js';

import {
    saveSleepLog, toggleSleepHistory, deleteSleepLogEntry,
    renderSleepPendingBanner, cancelPendingSleepLog
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
    ytSetVolume, ytToggleLoop, deleteYtHistoryEntry
} from './youtube.js';

import { renderGarden, renderHeatmap, renderTrendChart } from './charts.js';

import {
    downloadDayLog, shareDayLog, sendReportViaEmail, downloadReport, shareReport
} from './reports.js';

import { exportDataJSON, importDataJSON } from './backup.js';

import {
    signInWithGoogle, signOutOfGoogle, pushToCloud, pullFromCloud,
    deleteCloudData, initFirebaseAuthIfNeeded, renderSyncUI, showPendingToastIfAny
} from './firebase-sync.js';

import {
    enableNotifications, saveNotifSettingsFromUI, renderNotifSettingsUI,
    updateNotifPermissionStatus, stopAlarmLoop
} from './notifications.js';

// -----------------------------------------------------------------------
// EXPOSE EVERY FUNCTION THE HTML's INLINE onclick/onchange HANDLERS CALL.
// (ES module top-level functions are NOT global — this is required.)
// -----------------------------------------------------------------------
Object.assign(window, {
    // storage.js
    resetAllData,
    // timer.js
    openSubjectModal, cancelSubjectModal, confirmStartStudy,
    pauseStudy, resumeStudy, takeBreak, changeSubjectMidSession, endDay,
    updateLiveSummary, flushAndRestartSegment,
    // ui.js
    showToast, closeSidebar, openSidebarPanel, checkDayRollover,
    renderQuoteOfDay, renderExamYearUI, setExamYear, tickCountdowns,
    clearCacheAndReload,
    // planner.js
    addTodo, toggleTodo, deleteTodo, calShiftMonth, renderSidebarTools,
    renderPlannerCalendar, openPlannerModal, closePlannerModal,
    addPlannerTask, togglePlannerTask, deletePlannerTask, renderPlannerTasks,
    openDatePicker,
    // charts.js
    renderGarden, renderHeatmap, renderTrendChart,
    // history.js
    loadHistoryData, deleteSubjectEntry, deleteStudySessionEntry,
    deleteBreakEntry, deleteStudyLog, deleteBreakLog,
    // sleep.js
    saveSleepLog, toggleSleepHistory, deleteSleepLogEntry, cancelPendingSleepLog,
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
    ytSetVolume, ytToggleLoop, deleteYtHistoryEntry,
    // reports.js
    downloadDayLog, shareDayLog, sendReportViaEmail, downloadReport, shareReport,
    // backup.js
    exportDataJSON, importDataJSON,
    // firebase-sync.js
    signInWithGoogle, signOutOfGoogle, pushToCloud, pullFromCloud,
    deleteCloudData,
    // notifications.js
    enableNotifications, saveNotifSettingsFromUI, stopAlarmLoop
});

// -----------------------------------------------------------------------
// INITIALIZATION SEQUENCE (replaces the original single-file window.onload)
// NOTE: a <script type="module"> runs after the document has finished
// parsing (it behaves like `defer`), so the DOM is already ready here —
// no DOMContentLoaded listener needed (and one added here could fire too
// late, since the event may already have passed by the time this module
// finishes loading and evaluates).
// -----------------------------------------------------------------------
async function initApp() {
    setCurrentDayKey(getTodayKey());

    // Redeem any toast that was queued right before a reload triggered by
    // cloud auto-load or the real-time sync listener — see
    // showPendingToastIfAny()'s own comment in firebase-sync.js for why
    // that can't just call showToast() directly before reloading.
    showPendingToastIfAny();

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

    // Header / quote / countdowns.
    renderQuoteOfDay();
    renderExamYearUI();
    tickCountdowns();                 // also runs checkDayRollover + notif checks + renderGarden
    setInterval(tickCountdowns, 1000);

    // Sidebar tools.
    renderSidebarTools();
    initPlannerCalendar();
    renderMistakeTagPicker();
    renderSleepPendingBanner();
    renderNotifSettingsUI();
    updateNotifPermissionStatus();

    // Charts.
    renderHeatmap();
    renderTrendChart();

    // Seed the backup-reminder timestamp on first run so it has a baseline.
    if (!getLastBackupAt()) markBackupDone();

    // Cloud sync: wire up the auth listener so a returning signed-in user
    // is recognized automatically; render the signed-out UI in the meantime.
    initFirebaseAuthIfNeeded();
    renderSyncUI();

    // PWA offline support.
    if ("serviceWorker" in navigator) {
        navigator.serviceWorker.register("./sw.js").catch(err => {
            console.error("Service worker registration failed:", err);
        });
    }
}

initApp();
