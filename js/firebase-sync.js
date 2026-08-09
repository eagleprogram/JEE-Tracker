import { getDB, saveDB, getPlannerDB, savePlannerDB, getRawFlag, setRawFlag, clearRawFlag, getSleepLog, writeSleepLog, getSleepPending, setSleepPending, getSyllabusProgress, saveSyllabusProgress, getNotifSettings, saveNotifSettings, getYtHistory, saveYtHistory, getExamYear, setStoredExamYear, getAllMockTests, openMockDB, MOCK_STORE } from './storage.js';
import { getTodayKey } from './utils.js';
// Forward reference — ui.js lands alongside this file in Step 7. Only used
// inside function bodies, safe against the circular module graph (both
// showToast and everything imported here are hoisted function declarations).
import { showToast } from './ui.js';
// Forward reference — reports.js (Step 6) needs sendReportViaEmail for the
// auto-report scheduler below.
import { sendReportViaEmail } from './reports.js';

// ----------------- FIREBASE CONFIG -----------------
const FIREBASE_CONFIG = {
    apiKey: "AIzaSyCHvTipTo9yc19FOB-o31GfRu0El3SIqzc",
    authDomain: "jee-study-tracker-99.firebaseapp.com",
    projectId: "jee-study-tracker-99",
    storageBucket: "jee-study-tracker-99.firebasestorage.app",
    messagingSenderId: "221533539699",
    appId: "1:221533539699:web:5a68a74a33898627cb4906"
};

let fbApp = null, fbDb = null, fbReady = false;
let fbAuth = null, currentUser = null;
let autoSyncInterval = null, autoReportInterval = null;
let cloudUnsubscribe = null;

export function getCurrentUser() { return currentUser; }

export function firebaseConfigured() { return !FIREBASE_CONFIG.apiKey.includes("PASTE_"); }

export function initFirebaseIfNeeded() {
    if (fbReady) return true;
    if (!firebaseConfigured()) { showToast("Sync disabled. Add Firebase keys in the code."); return false; }
    try {
        fbApp = firebase.initializeApp(FIREBASE_CONFIG);
        fbDb = firebase.firestore();
        fbReady = true;
        return true;
    } catch (e) { showToast("Firebase init failed: " + e.message); return false; }
}

export function initFirebaseAuthIfNeeded() {
    if (!initFirebaseIfNeeded()) return false;
    if (!fbAuth) {
        fbAuth = firebase.auth();
        fbAuth.onAuthStateChanged((user) => {
            currentUser = user;
            renderSyncUI();
            if (user) {
                showToast(`Signed in as ${user.displayName || user.email}`);
                startAutoServices();
                startCloudListener();
                autoLoadCloudDataIfNeeded();
            } else {
                if (autoSyncInterval) clearInterval(autoSyncInterval);
                if (autoReportInterval) clearInterval(autoReportInterval);
                stopCloudListener();
            }
        });
    }
    return true;
}

export async function signInWithGoogle() {
    if (!initFirebaseAuthIfNeeded()) return;
    try {
        let provider = new firebase.auth.GoogleAuthProvider();
        await fbAuth.signInWithPopup(provider);
    } catch (e) { alert("Sign-in failed: " + e.message); }
}

export function signOutOfGoogle() { if (fbAuth) fbAuth.signOut(); }

export async function pushToCloud(silent = false) {
    if (!initFirebaseAuthIfNeeded()) return;
    if (!currentUser) { if (!silent) alert("Sign in first."); return; }
    try {
        let now = Date.now();
        // Full sync: every content category goes to the cloud now. The one
        // exception is mock-test FILE ATTACHMENTS — base64 image/PDF blobs
        // that can exceed Firestore's 1MiB per-document limit on their own
        // once a user has logged a handful of tests with photos. The mock
        // test entries themselves (subject, score, notes, mistake tags) DO
        // sync — only each entry's `files` array is stripped before upload.
        let mockTests = (await getAllMockTests()).map(({ files, ...rest }) => ({ ...rest, hasFiles: !!(files && files.length > 0) }));
        let docRef = fbDb.collection("users").doc(currentUser.uid);
        await docRef.set({
            studyDB: getDB(),
            plannerDB: getPlannerDB(),
            sleepLog: getSleepLog(),
            sleepPending: getSleepPending(),
            syllabusProgress: getSyllabusProgress(),
            notifSettings: getNotifSettings(),
            ytHistory: getYtHistory(),
            examYear: getExamYear(),
            ytLastLink: getRawFlag("jee_yt_last_link") || "",
            mockTests,
            updatedAt: now
        });
        // Verify the write actually landed on the server (force a real
        // round-trip, bypassing local cache) before trusting it. Without
        // this, set() can resolve successfully off the SDK's local cache
        // while the server ends up holding different data — silently
        // desyncing "last synced" from what's actually in the cloud.
        let confirmDoc = await docRef.get({ source: "server" });
        if (!confirmDoc.exists || confirmDoc.data().updatedAt !== now) {
            throw new Error("Write did not verify on the server — try again.");
        }
        setRawFlag("jee_last_sync", now.toString());
        renderSyncUI();
        if (!silent) showToast("Saved to the cloud.");
    } catch (e) {
        if (!silent) alert("Save failed: " + e.message);
    }
}

// Cloud mock-test entries never carry `files` (stripped before upload — see
// pushToCloud). Never clear() the store or overwrite an existing local
// entry: either would destroy locally-attached mock-test images/PDFs, or
// wipe out a brand-new local entry the cloud snapshot predates. Only add
// entries that don't already exist locally.
async function restoreMockTests(entries) {
    if (!Array.isArray(entries)) return;
    let db = await openMockDB();
    let tx = db.transaction(MOCK_STORE, "readwrite");
    let store = tx.objectStore(MOCK_STORE);
    for (const e of entries) {
        const existing = await new Promise((resolve) => {
            const req = store.get(e.id);
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => resolve(undefined);
        });
        if (!existing) store.put({ ...e, files: [] });
    }
    await new Promise((resolve) => { tx.oncomplete = resolve; tx.onerror = resolve; });
}

// Shared by pullFromCloud (explicit, user-initiated) and the real-time
// listener below (automatic, from another device). Applies every synced
// category to local storage.
async function applyCloudData(data) {
    saveDB(data.studyDB || {});
    savePlannerDB(data.plannerDB || {});
    if (data.sleepLog) writeSleepLog(data.sleepLog);
    if (data.sleepPending !== undefined) setSleepPending(data.sleepPending);
    if (data.syllabusProgress) saveSyllabusProgress(data.syllabusProgress);
    if (data.notifSettings) saveNotifSettings(data.notifSettings);
    if (data.ytHistory) saveYtHistory(data.ytHistory);
    if (data.examYear) setStoredExamYear(data.examYear);
    if (data.ytLastLink) setRawFlag("jee_yt_last_link", data.ytLastLink);
    await restoreMockTests(data.mockTests);
}

export async function pullFromCloud() {
    if (!initFirebaseAuthIfNeeded()) return;
    if (!currentUser) { alert("Sign in first."); return; }
    if (!confirm("This will REPLACE all study logs, planner tasks, sleep log, syllabus progress, notification settings, YouTube history, exam year, and mock test entries (scores & notes — not attached files) on THIS device with your saved cloud data. Continue?")) return;
    try {
        let doc = await fbDb.collection("users").doc(currentUser.uid).get();
        if (!doc.exists) { alert("No cloud data saved yet — tap Save to Cloud first."); return; }
        let data = doc.data();
        await applyCloudData(data);
        setRawFlag("jee_last_sync", (data.updatedAt || Date.now()).toString());
        alert("Loaded! The page will reload.");
        location.reload();
    } catch (e) { alert("Load failed: " + e.message); }
}

// Runs once right after sign-in. If this device has never synced before
// (jee_last_sync unset) and cloud data exists, load it automatically —
// previously data only ever appeared after a manual "Load from Cloud" tap,
// because the real-time listener below deliberately ignores its very first
// snapshot on a fresh device (see startCloudListener's lastLocalSync guard).
// That guard still protects against clobbering unsynced local work: if this
// device already has real local study data, this asks first instead of
// silently overwriting it.
async function autoLoadCloudDataIfNeeded() {
    if (!currentUser) return;
    let alreadySynced = parseInt(getRawFlag("jee_last_sync") || "0", 10) > 0;
    if (alreadySynced) return;
    try {
        let doc = await fbDb.collection("users").doc(currentUser.uid).get();
        if (!doc.exists) return; // nothing saved to the cloud yet for this account
        let data = doc.data();
        let localHasData = Object.keys(getDB() || {}).length > 0;
        if (localHasData) {
            if (!confirm("Cloud data was found for this account. Load it onto this device now? This will replace the study logs, planner tasks, and other data currently on this device.")) return;
        }
        await applyCloudData(data);
        setRawFlag("jee_last_sync", (data.updatedAt || Date.now()).toString());
        showToast("Loaded your data from the cloud.");
        location.reload();
    } catch (e) {
        console.log("Auto-load from cloud failed:", e.message);
    }
}

// ----------------- REAL-TIME SYNC -----------------
// Listens for changes to this account's cloud document — e.g. saved from
// another device or tab — and offers to apply them here.
//
// The lastLocalSync > 0 guard exists specifically for the first sign-in:
// Firestore's onSnapshot fires immediately with whatever's already in the
// cloud the moment the listener attaches, before the user has done anything
// on this device. Without the guard, signing in for the first time on a
// second device would immediately prompt to overwrite fresh local data with
// old cloud data (or vice versa) before the user has decided what they
// actually want — pushToCloud/pullFromCloud remain the explicit, safe way to
// resolve that first sync. After that first manual sync, jee_last_sync is
// set and this listener can safely react to later changes.
function startCloudListener() {
    if (!fbDb || !currentUser || cloudUnsubscribe) return;
    cloudUnsubscribe = fbDb.collection("users").doc(currentUser.uid).onSnapshot(async (doc) => {
        if (!doc.exists) return;
        // Skip local echoes of our own writes (pushToCloud). Firestore fires
        // this listener the instant a write is queued locally, before the
        // server acknowledges it and before pushToCloud has a chance to
        // update jee_last_sync — a race that previously slipped past the
        // timestamp check below and triggered a false "new data from
        // another device" prompt, whose reload then aborted our own
        // in-flight push. hasPendingWrites is true only for that unconfirmed
        // local echo, never for a genuinely remote change, so this is a
        // clean, race-free filter.
        if (doc.metadata.hasPendingWrites) return;
        let lastLocalSync = parseInt(getRawFlag("jee_last_sync") || "0", 10);
        if (lastLocalSync <= 0) return;
        let data = doc.data();
        let remoteUpdatedAt = data.updatedAt || 0;
        // Only react to a genuinely newer write from elsewhere — otherwise
        // this fires as an echo of our own pushToCloud() on this same tab.
        if (remoteUpdatedAt <= lastLocalSync) return;
        if (!confirm("New data was saved to the cloud from another device. Load it here now? This will replace local data on this device.")) return;
        await applyCloudData(data);
        setRawFlag("jee_last_sync", remoteUpdatedAt.toString());
        showToast("Synced from another device.");
        location.reload();
    }, (err) => {
        console.log("Cloud listener error:", err.message);
    });
}

function stopCloudListener() {
    if (cloudUnsubscribe) { cloudUnsubscribe(); cloudUnsubscribe = null; }
}

export async function deleteCloudData() {
    if (!initFirebaseAuthIfNeeded()) return;
    if (!currentUser) { alert("Sign in first."); return; }
    if (!confirm("This will permanently DELETE all your cloud data for this account. Local data on this device will remain. Continue?")) return;
    try {
        await fbDb.collection("users").doc(currentUser.uid).delete();
        clearRawFlag("jee_last_sync");
        showToast("Cloud data deleted.");
        renderSyncUI();
    } catch (e) { alert("Delete failed: " + e.message); }
}

export function renderSyncUI() {
    document.getElementById("sync-setup-note").innerText = firebaseConfigured() ? "" : "Cloud sync is not configured. To enable, add your Firebase keys in the code (search `FIREBASE_CONFIG`).";
    let signedOutBlock = document.getElementById("signed-out-block");
    let signedInBlock = document.getElementById("signed-in-block");
    if (!signedOutBlock) return;
    if (currentUser) {
        signedOutBlock.style.display = "none";
        signedInBlock.style.display = "block";
        document.getElementById("account-name").innerText = currentUser.displayName || currentUser.email;
        let avatar = document.getElementById("account-avatar");
        if (currentUser.photoURL) { avatar.src = currentUser.photoURL; avatar.style.display = "block"; }
        let last = getRawFlag("jee_last_sync");
        document.getElementById("sync-last").innerText = last ? `Last synced: ${new Date(parseInt(last)).toLocaleString()}` : "Not saved to the cloud yet.";
    } else {
        signedOutBlock.style.display = "block";
        signedInBlock.style.display = "none";
    }
}

// ----------------- AUTO SYNC & AUTO REPORTS -----------------
export function startAutoServices() {
    if (autoSyncInterval) clearInterval(autoSyncInterval);
    if (autoReportInterval) clearInterval(autoReportInterval);

    // Auto Cloud Sync every 2 hours (7,200,000 ms)
    autoSyncInterval = setInterval(() => {
        if (currentUser) { pushToCloud(true); }
    }, 7200000);

    // Auto Email Reports check every 1 minute... (original comment; the
    // actual interval below is 7,200,000ms/2hrs, matching source exactly —
    // flagging the comment/interval mismatch here rather than silently
    // "fixing" it, since it's the original's own inconsistency, not ours)
    autoReportInterval = setInterval(() => {
        if (!currentUser) return;
        let now = new Date();
        let todayKey = getTodayKey();

        // Weekly Report on Sunday
        if (now.getDay() === 0) {
            let flagKey = "weekly_report_sent_" + todayKey;
            if (!getRawFlag(flagKey)) {
                sendReportViaEmail('weekly', true);
                setRawFlag(flagKey, "1");
                setRawFlag("weekly_report_sent_last", todayKey);
            }
        }

        // Monthly Report on last day of month
        let tomorrow = new Date(now);
        tomorrow.setDate(tomorrow.getDate() + 1);
        if (tomorrow.getMonth() !== now.getMonth()) {
            let flagKey = "monthly_report_sent_" + todayKey;
            if (!getRawFlag(flagKey)) {
                sendReportViaEmail('monthly', true);
                setRawFlag(flagKey, "1");
                setRawFlag("monthly_report_sent_last", todayKey);
            }
        }
    }, 7200000);
}
