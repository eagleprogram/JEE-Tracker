import { getTodayKey, generateId } from './utils.js';

// ----------------- KEYS / CONSTANTS -----------------
const SYLLABUS_KEY = "jee_syllabus_progress";
const NOTIF_DEFAULTS = { enabled: false, breakOverrun: true, breakThresholdMin: 45, plannerReminder: true, examMilestones: true, idleNudge: true, idleThresholdMin: 30, revisionReminder: true, sleepReminder: true, parentLogReminder: true };
const YT_HISTORY_KEY = "jee_yt_history";
const YT_HISTORY_MAX = 20;
export const MOCK_DB_NAME = "jee_mocktest_db";
export const MOCK_STORE = "tests";
export const EXAM_YEAR_KEY = "jee_exam_year";
export const BASE_EXAM_YEAR = 2027;
export const BASE_EXAM_DATES = { mains1: "2027-01-21T00:00:00+05:30", mains2: "2027-04-02T00:00:00+05:30", adv: "2027-05-17T00:00:00+05:30" };

// ----------------- STUDY DAY DB -----------------
export function blankDay() {
    return { subjects: { "Physics": 0, "Organic Chemistry": 0, "Inorganic Chemistry": 0, "Physical Chemistry": 0, "Mathematics": 0, "Revision": 0, "School Prep": 0, "Mock Test / Analysis": 0 }, breaks: [], studySessions: [], todos: [], slots: [], totalStudy: 0, totalBreak: 0 };
}

export function ensureDayShape(day) {
    if (!day.studySessions) day.studySessions = [];
    if (!day.breaks) day.breaks = [];
    // Backfill ids on entries saved before this fix — sorting/deleting now
    // relies on id, not array position.
    day.studySessions.forEach(s => { if (!s.id) s.id = generateId(); });
    day.breaks.forEach(b => { if (!b.id) b.id = generateId(); });
    return day;
}

export function getDB() {
    let raw = localStorage.getItem("jee_ypt_v3_data");
    return raw ? JSON.parse(raw) : {};
}

export function saveDB(data) { localStorage.setItem("jee_ypt_v3_data", JSON.stringify(data)); }

export function initDay(dayKey) {
    let db = getDB();
    if (!db[dayKey]) { db[dayKey] = blankDay(); saveDB(db); }
    return db[dayKey];
}

export function initToday() { return initDay(getTodayKey()); }

// ----------------- ACTIVE (in-progress) SESSION -----------------
// Raw key read/write only — timer.js owns the state-machine logic
// (persistActiveSession / clearActiveSession / tryRestoreActiveSession)
// and calls these three so it never touches localStorage directly.
export function saveActiveSessionRaw(snapshot) { localStorage.setItem("jee_active_session", JSON.stringify(snapshot)); }
export function readActiveSessionRaw() { return localStorage.getItem("jee_active_session"); }
export function clearActiveSessionRaw() { localStorage.removeItem("jee_active_session"); }

// ----------------- PLANNER (todo + calendar) -----------------
export function getPlannerDB() { let raw = localStorage.getItem("jee_planner_tasks"); return raw ? JSON.parse(raw) : {}; }
export function savePlannerDB(data) { localStorage.setItem("jee_planner_tasks", JSON.stringify(data)); }

// ----------------- SLEEP LOG -----------------
const SLEEP_LOG_KEY = "jee_sleep_log";
export function getSleepLog() {
    try { return JSON.parse(localStorage.getItem(SLEEP_LOG_KEY) || "{}"); } catch (e) { return {}; }
}
// Raw setter for the whole log object. Named writeSleepLog (not saveSleepLog)
// because sleep.js's saveSleepLog() is the UI-facing "save today's entry"
// handler — that name was already taken by the blueprint's Step 4 file.
// The original inline importDataJSON() wrote localStorage.setItem(SLEEP_LOG_KEY, ...)
// directly; routed through here instead so storage.js stays the only file
// touching localStorage.
export function writeSleepLog(log) { localStorage.setItem(SLEEP_LOG_KEY, JSON.stringify(log)); }

export function getSleepPending() {
    try { return JSON.parse(localStorage.getItem("jee_sleep_pending") || "null"); } catch (e) { return null; }
}

export function setSleepPending(pending) {
    localStorage.setItem("jee_sleep_pending", JSON.stringify(pending));
}

// ----------------- SYLLABUS -----------------
export function getSyllabusProgress() { try { return JSON.parse(localStorage.getItem(SYLLABUS_KEY) || "{}"); } catch (e) { return {}; } }
export function saveSyllabusProgress(p) { localStorage.setItem(SYLLABUS_KEY, JSON.stringify(p)); }

// ----------------- NOTIFICATIONS -----------------
export function getNotifSettings() { let raw = localStorage.getItem("jee_notif_settings"); return raw ? { ...NOTIF_DEFAULTS, ...JSON.parse(raw) } : { ...NOTIF_DEFAULTS }; }
export function saveNotifSettings(s) { localStorage.setItem("jee_notif_settings", JSON.stringify(s)); }

// ----------------- YOUTUBE HISTORY -----------------
// Pure read/write only — storage.js stays the only file touching
// localStorage directly. The render/re-fetch behavior around these
// (addToYtHistory, deleteYtHistoryEntry) now lives in youtube.js itself,
// since that's the only module that ever calls them; this also removes the
// storage.js -> youtube.js -> storage.js circular import that used to exist.
export function getYtHistory() { try { return JSON.parse(localStorage.getItem(YT_HISTORY_KEY) || "[]"); } catch (e) { return []; } }
export function saveYtHistory(hist) { localStorage.setItem(YT_HISTORY_KEY, JSON.stringify(hist)); }
export const YT_HISTORY_MAX_ENTRIES = YT_HISTORY_MAX;

// ----------------- MOCK TESTS (IndexedDB) -----------------
// Bumped from 1 -> 2. Some browsers ended up with this database already
// created at version 1 but missing the "tests" object store (a stale/partial
// DB from an earlier session). IndexedDB only runs onupgradeneeded — which
// is where the store gets created — when the requested version is HIGHER
// than what's already stored. Reopening at the same version 1 forever never
// re-ran that check, so the store was permanently missing and every
// transaction() call (including the one inside pushToCloud()) threw
// "One of the specified object stores was not found." Requesting version 2
// forces onupgradeneeded to run once more; the existing
// `if (!contains(MOCK_STORE))` guard then creates the missing store without
// touching any data that *was* already there.
// Bumped 2 -> 3 to add the "mistakes" store (per-chapter mistake counter,
// notes, and attachments) alongside the existing mock-test store. Same
// database as mock tests — one IndexedDB connection covers both, and
// onupgradeneeded's per-store `if (!contains(...))` guards mean this never
// touches data already in the "tests" store.
// Bumped 3 -> 4: any browser that had already opened this DB at version 3
// BEFORE the "mistakes" store-creation line above existed (i.e. it visited
// between the version bump shipping and the store-creation code shipping —
// the exact same class of incident the 1 -> 2 bump above was written to
// fix) is permanently stuck on a version-3 database missing the "mistakes"
// store. indexedDB.open() only fires onupgradeneeded when the requested
// version is HIGHER than what's already recorded for that origin, so
// reopening at version 3 forever would never re-run the creation guard for
// those browsers — every saveMistakeEntry()/getAllMistakeChapters() call
// then throws "NotFoundError: One of the specified object stores was not
// found" the moment it opens a transaction, which was silently swallowed
// (no .catch on the promise chain) and looked like "adding a mistake
// doesn't save anything." Requesting version 4 forces onupgradeneeded to
// run once more for every browser, and the existing per-store `if
// (!contains(...))` guards mean this is a no-op for anyone who already has
// the store — no data in "tests" or "mistakes" is touched.
export const MISTAKE_STORE = "mistakes";
const MOCK_DB_VERSION = 4;
export function openMockDB() {
    return new Promise((resolve, reject) => {
        let req = indexedDB.open(MOCK_DB_NAME, MOCK_DB_VERSION);
        req.onupgradeneeded = (e) => {
            let db = e.target.result;
            if (!db.objectStoreNames.contains(MOCK_STORE)) db.createObjectStore(MOCK_STORE, { keyPath: "id" });
            if (!db.objectStoreNames.contains(MISTAKE_STORE)) db.createObjectStore(MISTAKE_STORE, { keyPath: "key" });
        };
        req.onsuccess = (e) => resolve(e.target.result);
        req.onerror = (e) => reject(e.target.error);
    });
}

export function getAllMockTests() {
    return openMockDB().then(db => new Promise((resolve, reject) => {
        let tx = db.transaction(MOCK_STORE, "readonly");
        let req = tx.objectStore(MOCK_STORE).getAll();
        req.onsuccess = () => resolve(req.result.sort((a,b) => b.id - a.id));
        req.onerror = () => reject(req.error);
    }));
}

// ----------------- MISTAKES (per syllabus chapter, IndexedDB) -----------------
// One record per "Subject|Chapter" key — the same key format syllabus.js
// uses for its progress object, so the chapter list can be shared.
export function getMistakeEntry(key) {
    return openMockDB().then(db => new Promise((resolve, reject) => {
        let tx = db.transaction(MISTAKE_STORE, "readonly");
        let req = tx.objectStore(MISTAKE_STORE).get(key);
        req.onsuccess = () => resolve(req.result || null);
        req.onerror = () => reject(req.error);
    }));
}

export function saveMistakeEntry(entry) {
    return openMockDB().then(db => new Promise((resolve, reject) => {
        let tx = db.transaction(MISTAKE_STORE, "readwrite");
        tx.objectStore(MISTAKE_STORE).put(entry);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
    }));
}

export function getAllMistakeChapters() {
    return openMockDB().then(db => new Promise((resolve, reject) => {
        let tx = db.transaction(MISTAKE_STORE, "readonly");
        let req = tx.objectStore(MISTAKE_STORE).getAll();
        req.onsuccess = () => resolve(req.result || []);
        req.onerror = () => reject(req.error);
    }));
}

// ----------------- EXAM YEAR -----------------
export function getExamYear() {
    let y = parseInt(localStorage.getItem(EXAM_YEAR_KEY), 10);
    return (y && y >= 2027 && y <= 2031) ? y : BASE_EXAM_YEAR;
}
// Raw setter — original's setExamYear() (ui.js) wrote localStorage directly;
// routed through here so storage.js stays the only file touching localStorage.
export function setStoredExamYear(year) { localStorage.setItem(EXAM_YEAR_KEY, String(year)); }

// ----------------- BACKUP -----------------
export function markBackupDone() { localStorage.setItem("jee_last_backup", Date.now().toString()); }
export function getLastBackupAt() {
    let v = parseInt(localStorage.getItem("jee_last_backup") || "0", 10);
    return isNaN(v) ? 0 : v;
}

// Generic raw key read/write for the handful of one-off "last notified at"
// / "already notified today" flag keys notifications.js uses (per-day
// planner/sleep/revision/parent-log reminder cooldowns). The original wrote
// these with localStorage.getItem/setItem directly; routed through here so
// storage.js stays the only file touching localStorage.
export function getRawFlag(key) { return localStorage.getItem(key); }
export function setRawFlag(key, value) { localStorage.setItem(key, value); }
export function clearRawFlag(key) { localStorage.removeItem(key); }

// ----------------- FULL RESET -----------------
export function resetAllData() {
    if (!confirm("This will permanently DELETE all study logs, planner tasks, sleep logs, and mock tests from this device. This action cannot be undone! Are you sure?")) return;
    localStorage.clear();
    let req = indexedDB.deleteDatabase(MOCK_DB_NAME);
    req.onsuccess = () => { location.reload(); };
    req.onerror = () => { location.reload(); };
}
