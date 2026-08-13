import { getDB, saveDB, getPlannerDB, savePlannerDB, getRawFlag, setRawFlag, clearRawFlag, getSleepLog, writeSleepLog, getSleepPending, setSleepPending, getSyllabusProgress, saveSyllabusProgress, getNotifSettings, saveNotifSettings, getYtHistory, saveYtHistory, getExamYear, setStoredExamYear, getAllMockTests, openMockDB, MOCK_STORE, getAllMistakeChapters, getMistakeEntry, saveMistakeEntry, getLastBackupAt } from './storage.js';
// mistakes.js switched each chapter's stored record from one flat
// {count, notes, files} blob to an `entries` array (separately editable
// mistake log entries). normalizeRecord() upgrades either shape (a record
// synced from an older client may still be the old flat shape) into the
// new one, so sync logic below never has to branch on which shape it got.
import { normalizeRecord } from './mistakes.js';
import { getTodayKey } from './utils.js';
// Forward reference — ui.js lands alongside this file in Step 7. Only used
// inside function bodies, safe against the circular module graph (both
// showToast and everything imported here are hoisted function declarations).
import { showToast, maybeShowGuestSignInReminder, hideGuestSignInReminder } from './ui.js';
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
let autoSyncInterval = null, autoSyncTimeout = null, autoReportInterval = null;
let cloudUnsubscribe = null;
// Set synchronously (before any `await`) inside the main onAuthStateChanged
// handler below, the moment it decides to auto-load cloud data — so
// resolveInitialAuthAndSync() can await the SAME in-flight call instead of
// triggering a second, racing one. See that function's own comment further
// down for why this matters.
let initialAutoLoadPromise = null;

export function getCurrentUser() { return currentUser; }

// Exposed for push-notifications.js — it needs the initialized Firebase App
// (for firebase.messaging()) and the Firestore handle (to save/remove this
// device's push token), without duplicating the init/config logic above.
export function getFirebaseApp() { return initFirebaseIfNeeded() ? fbApp : null; }
export function getFirebaseDb() { return fbDb; }

// Redeems a toast message that was queued right before a location.reload()
// (see autoLoadCloudDataIfNeeded and startCloudListener) — called once from
// main.js's initApp() so it's shown after the page has actually repainted,
// instead of being lost in the reload that immediately followed the
// original showToast() call.
export function showPendingToastIfAny() {
    let msg = getRawFlag("jee_pending_toast");
    if (msg) { showToast(msg); clearRawFlag("jee_pending_toast"); }
}

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
                hideGuestSignInReminder();
                startAutoServices();
                startCloudListener();
                initialAutoLoadPromise = autoLoadCloudDataIfNeeded();
            } else {
                if (autoSyncTimeout) clearTimeout(autoSyncTimeout);
                if (autoSyncInterval) clearInterval(autoSyncInterval);
                if (autoReportInterval) clearInterval(autoReportInterval);
                stopCloudListener();
                // Small delay so this doesn't pop before the rest of the UI
                // has finished its first render.
                setTimeout(maybeShowGuestSignInReminder, 1500);
            }
        });
    }
    return true;
}

// ----------------- BOOT-TIME AUTH GATE -----------------
// BUG FIX: main.js used to render/mutate local data (day-rollover,
// todo-carryover confirm dialog, planner calendar, history, etc. — all via
// tickCountdowns()/checkDayRollover()) BEFORE initFirebaseAuthIfNeeded() was
// even called. Auth resolution, and any resulting cloud auto-load +
// location.reload() from autoLoadCloudDataIfNeeded(), only happened
// strictly AFTER. That's a race: on a device that's actually still signed
// in (e.g. right after "Delete Cookies & Reload", which can leave
// Firebase's own auth session intact even though this app's local data was
// wiped), the day-rollover/todo-carryover dialog could fire and mutate
// local planner data against an empty/stale local DB — get approved by the
// user — and moments later autoLoadCloudDataIfNeeded() would detect the
// sign-in, silently pull the (older) cloud snapshot on top of it, and
// reload — wiping out exactly what was just approved. Reported as: "the
// to-do transfer dialog came, I accepted it, then everything went away."
//
// resolveInitialAuthAndSync() lets main.js `await` ONE settled outcome
// before touching any local data at all: either (a) the user is signed
// out/guest — nothing to wait for, resolves immediately; or (b) the user IS
// signed in and autoLoadCloudDataIfNeeded() has finished deciding whether
// to pull. If it did pull, the page is already mid-reload by the time this
// resolves — so nothing after the `await` in main.js ever runs anyway, the
// reload replaces the whole JS context and boots fresh with the correct
// (already-merged) local data. Capped with a timeout so a slow/offline
// network never blocks first paint indefinitely.
export function resolveInitialAuthAndSync() {
    return new Promise((resolve) => {
        if (!initFirebaseAuthIfNeeded()) { resolve(); return; } // sync not configured — nothing to wait for
        let settled = false;
        let finish = () => { if (!settled) { settled = true; resolve(); } };
        // BUG FIX: was 4000ms. On a slow/just-reconnected network (e.g. right
        // after "Delete Cookies & Reload", or a flaky mobile connection) the
        // real auth-state + cloud-auto-load round trip can take longer than
        // that, so this timeout could fire and let main.js's boot sequence
        // (including runBootSignInGate()) proceed while the actual sign-in
        // was still resolving — the exact race behind "to-do transfer came,
        // I accepted, then sign-in came and everything went away." 8s gives
        // a slow reconnect a real chance to finish first. If the real
        // sign-in DOES land after this timeout anyway, onAuthStateChanged's
        // signed-in branch still calls hideGuestSignInReminder() itself
        // (see above), which quietly dismisses any sign-in prompt that's
        // still on screen at that point — never a silent overwrite.
        let timeoutId = setTimeout(finish, 8000); // never hold first paint hostage to a dead network forever
        let unsub = fbAuth.onAuthStateChanged(async (user) => {
            if (typeof unsub === "function") unsub();
            if (user) {
                // initialAutoLoadPromise was assigned synchronously by the
                // MAIN onAuthStateChanged listener above — it's registered
                // first, so it always runs before this one for the same
                // auth event, guaranteeing the promise exists by now.
                try { await initialAutoLoadPromise; } catch (e) { /* already logged inside autoLoadCloudDataIfNeeded */ }
            }
            clearTimeout(timeoutId);
            finish();
        });
    });
}

export async function signInWithGoogle() {
    if (!initFirebaseAuthIfNeeded()) return;
    try {
        let provider = new firebase.auth.GoogleAuthProvider();
        await fbAuth.signInWithPopup(provider);
    } catch (e) { alert("Sign-in failed: " + e.message); }
}

// Returns a promise so callers that need sign-out to actually finish before
// doing something else (e.g. ui.js's deleteCookiesAndReload, which wipes
// local data right after) can await it instead of racing it.
export function signOutOfGoogle() { return fbAuth ? fbAuth.signOut() : Promise.resolve(); }

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
        let mockTests = (await getAllMockTests()).map(({ files, ...rest }) => ({ ...rest, hasFiles: !!(files && files.length > 0) || !!rest.hasFiles }));
        // Same file-stripping approach as mock tests: each entry's counter,
        // notes, and hasFiles flag sync — the actual attachment bytes don't
        // (keeps documents under Firestore's 1MiB limit). Each chapter can
        // now hold several separately-logged entries (see mistakes.js).
        let mistakeChapters = (await getAllMistakeChapters()).map(rec => {
            let norm = normalizeRecord(rec) || { key: rec.key, subject: rec.subject, chapter: rec.chapter, entries: [], updatedAt: rec.updatedAt || 0 };
            return {
                key: norm.key, subject: norm.subject, chapter: norm.chapter, updatedAt: norm.updatedAt,
                entries: (norm.entries || []).map(({ files, ...erest }) => ({ ...erest, hasFiles: !!(files && files.length > 0) || !!erest.hasFiles }))
            };
        });
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
            // Lets the scheduled server-side push job (server/send-scheduled-alarms.js)
            // compute the "2+ days since backup" reminder too — it has no
            // other way to know when this device last exported a backup.
            lastBackupAt: getLastBackupAt(),
            mockTests,
            mistakeChapters,
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
        showToast(silent ? "Auto-synced to the cloud." : "Saved to the cloud.");
    } catch (e) {
        // BUG FIX: silent (auto-sync) failures used to hit `if (!silent) alert(...)`
        // and do nothing at all — meaning a failed background sync looked
        // identical to a successful one from the user's perspective. A quiet
        // toast (not a blocking alert, which would be intrusive popping up
        // unprompted every 30 min) makes failures visible without interrupting
        // whatever the user is doing. Manual Save-to-Cloud keeps its existing
        // blocking alert, since that's an intentional user action expecting
        // a direct response.
        if (silent) { showToast("⚠️ Auto-sync failed — will retry next cycle."); return; }
        alert("Save failed: " + e.message);
    }
}

// Cloud mock-test entries never carry `files` (stripped before upload — see
// pushToCloud). Never clear() the store or overwrite an existing local
// entry's real fields: either would destroy locally-attached mock-test
// images/PDFs, or wipe out a brand-new local entry the cloud snapshot
// predates. New entries are added as-is; for an entry that already exists
// locally, the only thing ever touched is upgrading hasFiles false->true —
// every other field, and `files` itself, is left exactly as this browser
// already has it.
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
        if (!existing) {
            store.put({ ...e, files: [] });
        } else if (e.hasFiles && !existing.hasFiles) {
            store.put({ ...existing, hasFiles: true });
        }
    }
    await new Promise((resolve) => { tx.oncomplete = resolve; tx.onerror = resolve; });
}

// Unlike mock tests (add-only, never overwrite an existing entry — see
// restoreMockTests above), mistake entries are meant to be edited
// repeatedly across devices, so the cloud's metadata is merged onto
// whatever's local, entry-by-entry (matched by each entry's id). The one
// thing that's NEVER taken from the cloud is `files` — cloud entries never
// carry attachment bytes (see pushToCloud), so blindly overwriting `files`
// with the cloud's copy would silently wipe this browser's locally-attached
// images/PDFs. Entries that only exist locally (created after the last
// push, or never pushed) are kept rather than dropped.
async function restoreMistakeChapters(chapters) {
    if (!Array.isArray(chapters)) return;
    for (const cloudEntry of chapters) {
        let cloudNorm = normalizeRecord(cloudEntry) || { entries: [] };
        let localRaw = await getMistakeEntry(cloudEntry.key);
        let localNorm = normalizeRecord(localRaw) || { entries: [] };
        let localById = {};
        (localNorm.entries || []).forEach(e => { localById[String(e.id)] = e; });

        let mergedEntries = (cloudNorm.entries || []).map(ce => {
            let le = localById[String(ce.id)];
            return {
                id: ce.id,
                notes: ce.notes || "",
                count: ce.count || 1,
                hasFiles: !!ce.hasFiles,
                files: (le && le.files) ? le.files : [],
                createdAt: ce.createdAt || (le && le.createdAt) || Date.now()
            };
        });
        let cloudIds = new Set(mergedEntries.map(e => String(e.id)));
        (localNorm.entries || []).forEach(le => { if (!cloudIds.has(String(le.id))) mergedEntries.push(le); });

        await saveMistakeEntry({
            key: cloudEntry.key,
            subject: cloudEntry.subject,
            chapter: cloudEntry.chapter,
            entries: mergedEntries,
            // Keep whichever timestamp is newer so the View Mistakes
            // "newest/oldest" sort still reflects reality after a pull —
            // never blindly take the cloud's, since a chapter edited on
            // this device after the last push would otherwise look stale.
            updatedAt: Math.max(cloudEntry.updatedAt || 0, localNorm.updatedAt || 0)
        });
    }
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
    await restoreMistakeChapters(data.mistakeChapters);
}

export async function pullFromCloud() {
    if (!initFirebaseAuthIfNeeded()) return;
    if (!currentUser) { alert("Sign in first."); return; }
    if (!confirm("This will REPLACE all study logs, planner tasks, sleep log, syllabus progress, notification settings, YouTube history, exam year, mock test entries, and mistake-tracker entries (scores/counts & notes — not attached files) on THIS device with your saved cloud data. Continue?")) return;
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
        // BUG FIX: showToast() immediately followed by location.reload() never
        // actually appears — the toast <div> is appended to the DOM but the
        // reload wipes everything before the browser paints that frame, so
        // it's created and destroyed without ever being visible. Persisting
        // the message and showing it after the reload (via
        // showPendingToastIfAny(), called from main.js on init) guarantees
        // it's actually seen.
        setRawFlag("jee_pending_toast", "Loaded your data from the cloud.");
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
        // Same reason as autoLoadCloudDataIfNeeded above — see that comment.
        setRawFlag("jee_pending_toast", "Synced from another device.");
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
    // Avatar + display name now live in the "Account & Sync:" header row
    // itself (right-aligned next to the title) instead of their own row
    // inside the signed-in block — toggled in lockstep with signedInBlock
    // since they only make sense to show once signed in.
    let headerUser = document.getElementById("account-header-user");
    if (!signedOutBlock) return;
    if (currentUser) {
        signedOutBlock.style.display = "none";
        signedInBlock.style.display = "block";
        if (headerUser) headerUser.style.display = "flex";
        document.getElementById("account-name").innerText = currentUser.displayName || currentUser.email;
        let avatar = document.getElementById("account-avatar");
        if (currentUser.photoURL) { avatar.src = currentUser.photoURL; avatar.style.display = "block"; }
        let last = getRawFlag("jee_last_sync");
        document.getElementById("sync-last").innerText = last ? `Last synced: ${new Date(parseInt(last)).toLocaleString()}` : "Not saved to the cloud yet.";
    } else {
        signedOutBlock.style.display = "block";
        signedInBlock.style.display = "none";
        if (headerUser) headerUser.style.display = "none";
    }
}

// ----------------- AUTO SYNC & AUTO REPORTS -----------------
export function startAutoServices() {
    if (autoSyncTimeout) clearTimeout(autoSyncTimeout);
    if (autoSyncInterval) clearInterval(autoSyncInterval);
    if (autoReportInterval) clearInterval(autoReportInterval);

    // Auto Cloud Sync every 30 minutes, aligned to clock half-hours
    // (12:00, 12:30, 1:00, 1:30, ...) rather than 30 min after whenever the
    // page happened to load — so it lands on a predictable schedule as long
    // as the site stays open in a tab, instead of drifting per session.
    // (Previously: every 2 hours from page-load, unaligned.)
    let now = new Date();
    let msPastHalfHour = (now.getMinutes() % 30) * 60000 + now.getSeconds() * 1000 + now.getMilliseconds();
    let msUntilNextHalfHour = (30 * 60000) - msPastHalfHour;
    autoSyncTimeout = setTimeout(() => {
        if (currentUser) pushToCloud(true);
        autoSyncInterval = setInterval(() => {
            if (currentUser) pushToCloud(true);
        }, 30 * 60000);
    }, msUntilNextHalfHour);

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
