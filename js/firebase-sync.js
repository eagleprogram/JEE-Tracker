import { getDB, saveDB, getPlannerDB, savePlannerDB, getRawFlag, setRawFlag, clearRawFlag, getSleepLog, writeSleepLog, getSleepPending, setSleepPending, getSyllabusProgress, saveSyllabusProgress, getNotifSettings, saveNotifSettings, getYtHistory, saveYtHistory, getExamYear, setStoredExamYear, getAllMockTests, openMockDB, MOCK_STORE, getAllMistakeChapters, getMistakeEntry, saveMistakeEntry, getLastBackupAt, blankDay } from './storage.js';
// mistakes.js switched each chapter's stored record from one flat
// {count, notes, files} blob to an `entries` array (separately editable
// mistake log entries). normalizeRecord() upgrades either shape (a record
// synced from an older client may still be the old flat shape) into the
// new one, so sync logic below never has to branch on which shape it got.
import { normalizeRecord } from './mistakes.js';
import { getTodayKey, dateKeyFromWall } from './utils.js';
// Forward reference — ui.js lands alongside this file in Step 7. Only used
// inside function bodies, safe against the circular module graph (both
// showToast and everything imported here are hoisted function declarations).
import { showToast, maybeShowGuestSignInReminder, hideGuestSignInReminder } from './ui.js';
// Forward reference — reports.js (Step 6) needs sendReportViaEmail for the
// auto-report scheduler below.
import { sendReportViaEmail } from './reports.js';
// Forward reference — push-notifications.js (Step 8-ish) imports FROM this
// file (getFirebaseApp/getFirebaseDb/getCurrentUser), so this is the same
// kind of circular import already used elsewhere in the app (timer.js/
// ui.js, timer.js/charts.js, etc.) — safe because both functions imported
// here are only ever invoked from inside the onAuthStateChanged callback
// body below, well after the full module graph has finished loading, never
// at this file's own top-level evaluation time.
import { updatePushPermissionStatusUI, reregisterPushIfEnabled } from './push-notifications.js';

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
// Set true for the duration of pushToCloud() (see its own comment) so the
// real-time listener below can unconditionally ignore every snapshot while
// this tab's own push is in flight, instead of relying solely on timing.
let pushInFlight = false;

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
    if (!firebaseConfigured()) { showToast("Sync Disabled. Add Firebase Keys in the Code."); return false; }
    try {
        fbApp = firebase.initializeApp(FIREBASE_CONFIG);
        fbDb = firebase.firestore();
        fbReady = true;
        return true;
    } catch (e) { showToast("Firebase Init Failed: " + e.message); return false; }
}

export function initFirebaseAuthIfNeeded() {
    if (!initFirebaseIfNeeded()) return false;
    if (!fbAuth) {
        fbAuth = firebase.auth();
        fbAuth.onAuthStateChanged((user) => {
            currentUser = user;
            renderSyncUI();
            // BUG FIX: main.js's boot sequence only ever painted the
            // Background Alerts status ONCE, right after the very first
            // resolveInitialAuthAndSync() — using whatever currentUser was
            // at that single moment. If the real sign-in state settled
            // slightly later than that (a slow/flaky connection past the
            // 8s boot timeout, a silent token refresh, a genuine sign-in/
            // out later in the session), this listener already re-ran
            // renderSyncUI() to repaint the Account panel — but nothing
            // ever repainted the push status panel to match, so it could
            // permanently show a stale "Sign in first…" (looking like the
            // Enable click was forgotten) even once the user genuinely was
            // signed in with alerts already enabled on this device. Now
            // every real auth change — not just the very first boot
            // resolution — repaints it and quietly re-registers this
            // device's push token if it was already enabled.
            updatePushPermissionStatusUI();
            reregisterPushIfEnabled();
            if (user) {
                showToast(`Signed In as ${user.displayName || user.email}`);
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
        // BUG FIX: was 8000ms. Reported again as "todo transfer runs, THEN
        // the sign-in toast appears, so the transfer never actually syncs"
        // — happening only on the installed mobile PWA, never on desktop.
        // A cold PWA launch has to activate its service worker and warm up
        // IndexedDB (where Firebase Auth's persisted session lives) before
        // the auth SDK can even start resolving — on a slow device/network
        // that alone can eat past 8s, well before any real sign-in check
        // has happened. 20s gives a cold mobile launch a realistic margin.
        // If the real sign-in DOES land after this timeout anyway,
        // onAuthStateChanged's signed-in branch still calls
        // hideGuestSignInReminder() itself (see above), which quietly
        // dismisses any sign-in prompt still on screen at that point —
        // never a silent overwrite.
        let timeoutId = setTimeout(finish, 20000); // never hold first paint hostage to a dead network forever
        let unsub = fbAuth.onAuthStateChanged(async (user) => {
            if (typeof unsub === "function") unsub();
            if (user) {
                // initialAutoLoadPromise was assigned synchronously by the
                // MAIN onAuthStateChanged listener above — it's registered
                // first, so it always runs before this one for the same
                // auth event, guaranteeing the promise exists by now.
                try { await initialAutoLoadPromise; } catch (e) { /* already logged inside autoLoadCloudDataIfNeeded */ }
                clearTimeout(timeoutId);
                finish();
                return;
            }
            // BUG FIX: this is the actual root cause of the mobile-only
            // report above. Firebase Auth can fire its FIRST
            // onAuthStateChanged callback with user === null even on a
            // device that's genuinely still signed in — the persisted
            // session hasn't finished hydrating from IndexedDB at the
            // exact instant this very first callback runs, most commonly
            // right after a cold PWA launch. Resolving immediately on that
            // transient null (the old behavior) let main.js treat an
            // actually-signed-in device as a guest for a brief window —
            // long enough for the todo-carryover dialog to show and get
            // approved against local data — and moments later the REAL
            // sign-in would land (via the separate MAIN listener in
            // initFirebaseAuthIfNeeded, which is registered first and
            // still running), pop the "Signed in as …" toast, and pull/
            // overwrite what was just approved. This waits a short grace
            // window before treating a null as final: if the MAIN
            // listener's `currentUser` module variable has since been set
            // by a delayed correction, this proceeds exactly like the
            // signed-in branch above instead of resolving as a guest. A
            // genuinely signed-out device just resolves ~1.2s later than
            // before — not noticeable.
            setTimeout(async () => {
                if (currentUser) {
                    try { await initialAutoLoadPromise; } catch (e) { /* already logged inside autoLoadCloudDataIfNeeded */ }
                }
                clearTimeout(timeoutId);
                finish();
            }, 1200);
        });
    });
}

// BUG FIX (feature request): requesting the Calendar scope as part of
// normal sign-in caused real problems in practice — an intimidating
// "wants access to see, edit, share, and permanently delete calendar
// events" consent screen for EVERY user, whether or not they cared about
// Calendar sync at all, and (per the Testing-mode/verification
// constraints described elsewhere) actual errors for anyone not
// whitelisted yet. Reverted: plain sign-in requests no extra scope and no
// forced consent screen — fast and unremarkable for everyone, exactly
// like before Calendar sync was ever added. Calendar access is now ONLY
// ever requested from the dedicated icon in the Holiday Reference card
// (connectGoogleCalendar() below), for whoever actually wants it.
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

// ----------------- GOOGLE CALENDAR (feature request) -----------------
// Deliberately kept SEPARATE from the plain sign-in above: combining the
// Calendar scope into normal sign-in was tried and reverted — it made
// every sign-in show Google's "wants access to see, edit, share, and
// permanently delete calendar events" consent screen, which is enough of
// a red flag on an unverified app to make people bail on signing in at
// all. So signInWithGoogle() stays scope-free and fast; this is the ONLY
// path that ever requests Calendar access, and only when someone
// deliberately taps the Google icon on the Holiday Reference card.
//
// HONEST LIMIT: the access token returned here is a raw Google OAuth token,
// not a Firebase ID token — the Firebase JS SDK only auto-refreshes the
// latter in the background. This one is good for roughly an hour from
// when it's granted; after that, syncing again just re-prompts the same
// one-click consent popup (already-granted access isn't lost, Google just
// re-issues a fresh token instantly on most repeat prompts) — there's no
// way to silently refresh it from client-side code alone.
let googleCalendarAccessToken = null;
let googleCalendarTokenExpiresAt = 0;

export function getGoogleCalendarAccessToken() {
    if (googleCalendarAccessToken && Date.now() < googleCalendarTokenExpiresAt) return googleCalendarAccessToken;
    return null;
}

export async function connectGoogleCalendar() {
    if (!initFirebaseAuthIfNeeded()) return null;
    try {
        let provider = new firebase.auth.GoogleAuthProvider();
        provider.addScope("https://www.googleapis.com/auth/calendar.events");
        provider.setCustomParameters({ prompt: "consent" });
        // signInWithPopup on an account that's already signed in re-
        // authenticates the SAME Firebase account with the extra scope
        // added — it doesn't create a duplicate account. Picking a
        // DIFFERENT Google account in the popup is exactly how a user
        // connects a separate account for Calendar than the one they use
        // for app sync.
        let result = await fbAuth.signInWithPopup(provider);
        let credential = firebase.auth.GoogleAuthProvider.credentialFromResult(result);
        if (!credential || !credential.accessToken) {
            alert("Google didn't grant Calendar access — please try again and allow the Calendar permission.");
            return null;
        }
        googleCalendarAccessToken = credential.accessToken;
        googleCalendarTokenExpiresAt = Date.now() + 55 * 60 * 1000;
        return googleCalendarAccessToken;
    } catch (e) {
        alert("Couldn't connect Google Calendar: " + e.message);
        return null;
    }
}

export async function pushToCloud(silent = false) {
    if (!initFirebaseAuthIfNeeded()) return;
    if (!currentUser) { if (!silent) alert("Sign in first."); return; }
    // Belt-and-braces alongside the jee_last_sync-timing fix below: while
    // this tab has a push in flight, the real-time listener (startCloudListener)
    // ignores every snapshot outright rather than trying to work out whether
    // it's this push echoing back or a genuinely different device's change —
    // pushToCloud already applies the fully-merged result to local storage
    // itself when it finishes, so there's nothing the listener needs to do
    // for this tab's own write either way.
    pushInFlight = true;
    try {
        let now = Date.now();
        // Full sync: every content category goes to the cloud now. The one
        // exception is mock-test FILE ATTACHMENTS — base64 image/PDF blobs
        // that can exceed Firestore's 1MiB per-document limit on their own
        // once a user has logged a handful of tests with photos. The mock
        // test entries themselves (subject, score, notes, mistake tags) DO
        // sync — only each entry's `files` array is stripped before upload.
        let localMockTests = (await getAllMockTests()).map(({ files, ...rest }) => ({ ...rest, hasFiles: !!(files && files.length > 0) || !!rest.hasFiles }));
        // Same file-stripping approach as mock tests: each entry's counter,
        // notes, and hasFiles flag sync — the actual attachment bytes don't
        // (keeps documents under Firestore's 1MiB limit). Each chapter can
        // now hold several separately-logged entries (see mistakes.js).
        let localMistakeChapters = (await getAllMistakeChapters()).map(rec => {
            let norm = normalizeRecord(rec) || { key: rec.key, subject: rec.subject, chapter: rec.chapter, entries: [], updatedAt: rec.updatedAt || 0 };
            return {
                key: norm.key, subject: norm.subject, chapter: norm.chapter, updatedAt: norm.updatedAt,
                entries: (norm.entries || []).map(({ files, ...erest }) => ({ ...erest, hasFiles: !!(files && files.length > 0) || !!erest.hasFiles }))
            };
        });
        let localStudyDB = getDB();
        let localPlannerDB = getPlannerDB();
        let localSleepLog = getSleepLog();
        let localSyllabus = getSyllabusProgress();

        let docRef = fbDb.collection("users").doc(currentUser.uid);
        // BUG FIX (root cause of "cloud sync isn't working properly — data
        // present on mobile isn't coming across to the laptop and vice
        // versa"): this used to be a blind `docRef.set({studyDB: getDB(),
        // ...})` — every push OVERWROTE THE ENTIRE CLOUD DOCUMENT with only
        // what THIS device had locally, with no regard for what was already
        // sitting in the cloud. If device A pushed at 9am and device B
        // (which hadn't pulled A's 9am changes yet) pushed at 9:30am,
        // B's push didn't just add its own new data — it ERASED A's from
        // the cloud entirely, because B's payload was built purely from B's
        // own local storage. Reading the cloud doc INSIDE a transaction and
        // merging every category onto it (same merge functions
        // applyCloudData uses on the way IN, now also used on the way OUT)
        // makes a push additive instead of destructive, no matter which
        // device pushed most recently — and the transaction guarantees
        // we're merging against the truly-latest cloud state even if
        // another device's push lands in the split second between the read
        // and the write below.
        let mergedStudyDB, mergedPlannerDB, mergedSleepLog, mergedSyllabus, mergedMockTests, mergedMistakeChapters;
        await fbDb.runTransaction(async (tx) => {
            let cloudSnap = await tx.get(docRef);
            let cloud = cloudSnap.exists ? cloudSnap.data() : {};
            mergedStudyDB = mergeStudyDBs(cloud.studyDB || {}, localStudyDB);
            mergedPlannerDB = mergePlannerDBs(cloud.plannerDB || {}, localPlannerDB);
            mergedSleepLog = mergeSleepLogs(cloud.sleepLog || {}, localSleepLog);
            mergedSyllabus = mergeSyllabusProgress(cloud.syllabusProgress || {}, localSyllabus);
            mergedMockTests = mergeMockTestArraysForCloud(cloud.mockTests || [], localMockTests);
            mergedMistakeChapters = mergeMistakeChapterArraysForCloud(cloud.mistakeChapters || [], localMistakeChapters);

            tx.set(docRef, {
                studyDB: mergedStudyDB,
                plannerDB: mergedPlannerDB,
                sleepLog: mergedSleepLog,
                sleepPending: getSleepPending(),
                syllabusProgress: mergedSyllabus,
                notifSettings: getNotifSettings(),
                ytHistory: getYtHistory(),
                examYear: getExamYear(),
                ytLastLink: getRawFlag("jee_yt_last_link") || "",
                // Lets the scheduled server-side push job (server/send-scheduled-alarms.js)
                // compute the "2+ days since backup" reminder too — it has no
                // other way to know when this device last exported a backup.
                lastBackupAt: getLastBackupAt(),
                mockTests: mergedMockTests,
                mistakeChapters: mergedMistakeChapters,
                updatedAt: now
            });
        });

        // Write the merged result back to THIS device's own storage too —
        // otherwise this device would keep showing its own pre-merge data
        // (missing whatever the cloud had that this device hadn't seen
        // yet) until its next pull, even though the cloud now has the
        // fuller merged picture this device just wrote.
        saveDB(mergedStudyDB);
        savePlannerDB(mergedPlannerDB);
        writeSleepLog(mergedSleepLog);
        saveSyllabusProgress(mergedSyllabus);
        // BUG FIX (found in re-audit): mergedMockTests/mergedMistakeChapters
        // were only ever written to the CLOUD payload above — never applied
        // back to this device's own IndexedDB, unlike the four categories
        // just above. So if another device had logged a mock test or
        // mistake entry this device hadn't pulled yet, this device's push
        // correctly preserved it in the cloud, but wouldn't actually show it
        // locally until a separate explicit pull. restoreMockTests/
        // restoreMistakeChapters are already the exact add-only functions
        // used to apply an incoming cloud snapshot (see their own comments
        // above) — reusing them here on the merged result closes that last
        // gap, so a push is now just as complete as a pull for every synced
        // category.
        await restoreMockTests(mergedMockTests);
        await restoreMistakeChapters(mergedMistakeChapters);
        // BUG FIX: a follow-up `docRef.get({source:"server"})` used to sit
        // here to "verify" the write actually landed, because a plain
        // `docRef.set()` can resolve early from the SDK's local cache
        // before the server has actually acknowledged it. A Firestore
        // TRANSACTION doesn't have that failure mode at all — per the SDK's
        // own guarantee, runTransaction()'s promise only resolves once the
        // transaction has genuinely committed on the backend — so that
        // extra round-trip was pure dead weight AND actively harmful: the
        // `await` it introduced was a real gap where this tab's own
        // real-time listener (started below) could receive this exact
        // write, misread it as "new data from another device" (see the
        // hasPendingWrites comment on that listener — transactions don't
        // set that flag the way a plain write does, so the listener had no
        // way to recognize this as an echo of its own tab's push), and
        // race ahead of this function to reload the page before
        // jee_last_sync below had even been set — producing exactly the
        // "Write did not verify on the server" failure this was reported
        // as. Setting jee_last_sync IMMEDIATELY here, with no `await`
        // between it and the transaction resolving above, closes that gap:
        // by the time the listener's snapshot callback gets a turn to run,
        // jee_last_sync already reflects this exact write, so its own
        // `remoteUpdatedAt <= lastLocalSync` guard now correctly
        // recognizes it as this tab's own echo and skips it (see
        // `pushInFlight` below for a second, belt-and-braces guard against
        // the same class of race).
        setRawFlag("jee_last_sync", now.toString());
        renderSyncUI();
        showToast(silent ? "Auto-Synced to the Cloud." : "Saved to the Cloud.");
    } catch (e) {
        // BUG FIX: silent (auto-sync) failures used to hit `if (!silent) alert(...)`
        // and do nothing at all — meaning a failed background sync looked
        // identical to a successful one from the user's perspective. A quiet
        // toast (not a blocking alert, which would be intrusive popping up
        // unprompted every 30 min) makes failures visible without interrupting
        // whatever the user is doing. Manual Save-to-Cloud keeps its existing
        // blocking alert, since that's an intentional user action expecting
        // a direct response.
        if (silent) { showToast("⚠️ Auto-Sync Failed — Will Retry Next Cycle."); return; }
        alert("Save failed: " + e.message);
    } finally {
        pushInFlight = false;
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

// ----------------- STUDY DB MERGE (cloud <-> local) -----------------
// BUG FIX (root cause of "cloud sync isn't working properly — data on
// mobile doesn't come across to laptop and vice versa"): unlike plannerDB/
// mockTests/mistakeChapters below (which already merge cloud onto local
// entry-by-entry), studyDB — the actual study/break minutes, subject
// breakdown, and Today's Live Summary numbers — used to be applied with a
// blind `saveDB(data.studyDB || {})`, AND pushed with a blind
// `studyDB: getDB()` that overwrote the ENTIRE cloud document with only
// whatever this one device had locally. Combine those two one-way mirrors
// and syncing between two devices was never actually safe: whichever
// device synced LAST simply erased whatever the other device's studyDB
// held that this device hadn't already pulled in — exactly "not everything
// that's on mobile is coming across."
//
// study/break entries have no separate updatedAt, but they don't need one:
// timer.js's commit loop only ever EXTENDS an existing entry's `duration`
// in place (same id, every ~20s while that segment is still open) or
// creates a brand-new id — it never legitimately shrinks an entry's
// duration except by deleting it outright (history.js). So for a given id
// present on both sides, whichever copy has the LARGER duration is simply
// the newer one — no extra timestamp field needed. An id that exists on
// only one side is always kept (same no-tombstone trade-off already
// accepted for plannerDB/mockTests/mistakeChapters elsewhere in this file —
// a session deleted on one device can reappear if a snapshot predating
// that delete merges in later; closing that gap needs a soft-delete flag,
// a bigger change than this fix).
function mergeEntryArraysByIdAndDuration(a, b) {
    let byId = new Map();
    (a || []).forEach(e => { if (e && e.id) byId.set(e.id, e); });
    (b || []).forEach(e => {
        if (!e || !e.id) return;
        let existing = byId.get(e.id);
        if (!existing || (e.duration || 0) > (existing.duration || 0)) byId.set(e.id, e);
    });
    return Array.from(byId.values());
}

// subjects/totalStudy/totalBreak are maintained as running totals in
// timer.js/history.js, not derived on read — so after merging two
// independently-updated sets of sessions/breaks, the only trustworthy way
// to get correct aggregates is to recompute them FROM the merged entries,
// rather than trying to reconcile two already-diverged totals.
function recomputeDayAggregates(day) {
    let subjects = { ...blankDay().subjects };
    (day.studySessions || []).forEach(s => { subjects[s.subject] = (subjects[s.subject] || 0) + (s.duration || 0); });
    day.subjects = subjects;
    day.totalStudy = Object.values(subjects).reduce((sum, v) => sum + v, 0);
    day.totalBreak = (day.breaks || []).reduce((sum, b) => sum + (b.duration || 0), 0);
    return day;
}

function mergeDayObjects(a, b) {
    if (!a) return b;
    if (!b) return a;
    let merged = { ...blankDay(), ...a };
    merged.studySessions = mergeEntryArraysByIdAndDuration(a.studySessions, b.studySessions);
    merged.breaks = mergeEntryArraysByIdAndDuration(a.breaks, b.breaks);
    recomputeDayAggregates(merged);
    // questionsSolved/questionsAsked have no timestamp of their own — once
    // asked on EITHER device, treat the day as asked everywhere (never
    // re-nag with the popup), and keep whichever side actually has a real
    // logged answer.
    merged.questionsAsked = !!a.questionsAsked || !!b.questionsAsked;
    merged.questionsSolved = a.questionsAsked ? a.questionsSolved : (b.questionsAsked ? b.questionsSolved : 0);
    // todos/slots are legacy fields blankDay() still carries but nothing in
    // the app writes to anymore (plannerDB replaced them) — kept as-is from
    // whichever side has them, purely so old data already saved under these
    // keys is never dropped by a merge.
    merged.todos = (a.todos && a.todos.length ? a.todos : b.todos) || [];
    merged.slots = (a.slots && a.slots.length ? a.slots : b.slots) || [];
    return merged;
}

export function mergeStudyDBs(dbA, dbB) {
    dbA = dbA || {}; dbB = dbB || {};
    let dayKeys = new Set([...Object.keys(dbA), ...Object.keys(dbB)]);
    let merged = {};
    dayKeys.forEach(dayKey => { merged[dayKey] = mergeDayObjects(dbA[dayKey], dbB[dayKey]); });
    return merged;
}

// ----------------- SLEEP LOG MERGE (cloud <-> local) -----------------
// Sleep entries are keyed by date, one object per date-key (see
// storage.js), with no updatedAt of their own either. A COMPLETE entry
// (both a sleep side and a wake side actually filled in) is always strictly
// more informative than a half-open PENDING one started on the other device
// — so per date-key, whichever side is more complete wins; a date-key that
// only exists on one side is always kept.
function sleepEntryCompleteness(e) {
    if (!e) return -1;
    return (e.sleepTime ? 1 : 0) + (e.wakeTime ? 1 : 0) + (typeof e.durationMin === "number" ? 1 : 0);
}
function mergeSleepLogs(logA, logB) {
    logA = logA || {}; logB = logB || {};
    let keys = new Set([...Object.keys(logA), ...Object.keys(logB)]);
    let merged = {};
    keys.forEach(k => { merged[k] = sleepEntryCompleteness(logB[k]) > sleepEntryCompleteness(logA[k]) ? logB[k] : (logA[k] || logB[k]); });
    return merged;
}

// ----------------- SYLLABUS PROGRESS MERGE (cloud <-> local) -----------------
// Each chapter's tags (lecture/revision/DPP/etc.) are plain completion
// checkboxes with no timestamp — OR-merged per tag so a chapter marked done
// on one device can never be silently un-marked by an older snapshot from a
// device that hadn't caught up yet. (Deliberately un-checking a tag still
// works locally — it just re-syncs as done again if a stale snapshot from
// before that un-check merges in later, the same no-tombstone trade-off
// already accepted for the other categories in this file.)
function mergeSyllabusProgress(progA, progB) {
    progA = progA || {}; progB = progB || {};
    let keys = new Set([...Object.keys(progA), ...Object.keys(progB)]);
    let merged = {};
    keys.forEach(key => {
        let a = progA[key] || {}, b = progB[key] || {};
        let tags = new Set([...Object.keys(a), ...Object.keys(b)]);
        let entry = {};
        tags.forEach(tag => { entry[tag] = !!a[tag] || !!b[tag]; });
        merged[key] = entry;
    });
    return merged;
}

// ----------------- MOCK TESTS / MISTAKE CHAPTERS MERGE (for the OUTGOING cloud payload) -----------------
// restoreMockTests/restoreMistakeChapters below already merge an incoming
// cloud snapshot onto local storage safely (add-only, never overwrite real
// local fields). What they DIDN'T protect against: pushToCloud used to
// build its outgoing payload purely from this device's own local state and
// overwrite the cloud with it wholesale — so if a second device had added a
// mock test or mistake entry that this device never pulled down yet, THIS
// device's push would erase it from the cloud anyway. These mirror the same
// add-only philosophy, applied to the payload being written, not just the
// payload being read.
function mergeMockTestArraysForCloud(cloudTests, localTests) {
    let byId = new Map();
    (cloudTests || []).forEach(t => { if (t) byId.set(t.id, t); });
    (localTests || []).forEach(t => {
        if (!t) return;
        let existing = byId.get(t.id);
        byId.set(t.id, existing ? { ...existing, hasFiles: existing.hasFiles || t.hasFiles } : t);
    });
    return Array.from(byId.values());
}
function mergeMistakeChapterArraysForCloud(cloudChapters, localChapters) {
    let byKey = new Map();
    (cloudChapters || []).forEach(c => { if (c && c.key) byKey.set(c.key, c); });
    (localChapters || []).forEach(local => {
        if (!local || !local.key) return;
        let cloudEntry = byKey.get(local.key);
        if (!cloudEntry) { byKey.set(local.key, local); return; }
        let localIds = new Set((local.entries || []).map(e => String(e.id)));
        let combinedEntries = [...(local.entries || [])];
        (cloudEntry.entries || []).forEach(ce => { if (!localIds.has(String(ce.id))) combinedEntries.push(ce); });
        byKey.set(local.key, { key: local.key, subject: local.subject, chapter: local.chapter, entries: combinedEntries, updatedAt: Math.max(local.updatedAt || 0, cloudEntry.updatedAt || 0) });
    });
    return Array.from(byKey.values());
}

// ----------------- PLANNER MERGE (cloud <-> local) -----------------
// Unlike mock tests / mistake chapters just above (which already merge by
// id instead of overwriting — see restoreMockTests/restoreMistakeChapters),
// plannerDB used to be applied with a blind `savePlannerDB(data.plannerDB ||
// {})`. That's fine as long as a sync only ever runs against genuinely idle
// local data — but on mobile it silently destroyed same-day work in exactly
// the sequence users hit: the device backgrounds overnight, wakes up, and
// checkDayRollover() (ui.js) runs the todo-carryover confirm against
// today's still-local task list BEFORE any cloud snapshot has been fetched
// or merged in. See checkDayRollover()'s own comment in ui.js for the other
// half of this fix (fetching a fresh snapshot before carryover runs, not
// after) — this half makes APPLYING that snapshot (from the real-time
// listener, an explicit pull, the very first auto-load, or the new
// catch-up below) safe to do at any point, in any order, without losing
// whichever side wasn't in the snapshot yet.
//
// A task with no `id` (arriving from an older, not-yet-updated client
// mid-rollout, before storage.js started backfilling ids) is matched by
// exact text instead — the same fallback rule addTodo/addPlannerTask's own
// duplicate guard already uses.
function taskIdentity(t) { return t && t.id ? "id:" + t.id : "text:" + (t && t.text); }

// Newest-updatedAt-wins per task, not per whole day — so a task completed
// on one device and a DIFFERENT task added on another, both since the last
// sync, both survive; only a genuine same-task conflict (edited/toggled on
// both sides) picks a winner. A task that exists on only one side is always
// kept — merging only ever adds, it never silently drops a task neither
// side actually deleted.
//
// Known trade-off, shared with restoreMockTests above: there are no
// tombstones, so a task deleted on this device can reappear if a cloud
// snapshot that predates the deletion is merged in later. Same limitation
// mock-test deletions already have in this codebase — flagging it here
// rather than leaving it silent, since closing that gap properly needs a
// soft-delete flag, which is a bigger change than this fix.
// Pure merge — takes two plannerDBs, returns the merged result without
// touching storage. Split out so pushToCloud can merge local onto a
// FRESHLY-READ cloud snapshot (inside its transaction, see below) without
// this device's own storage being involved at all, while
// applyCloudData/catchUpPlannerFromCloud keep using the thin wrapper below
// exactly as before.
function mergePlannerDBs(dbA, dbB) {
    dbA = dbA || {}; dbB = dbB || {};
    let dayKeys = new Set([...Object.keys(dbA), ...Object.keys(dbB)]);

    // Pass 1: merge each day's list independently — newest updatedAt wins
    // per task identity WITHIN that one day-key.
    let merged = {};
    dayKeys.forEach(dayKey => {
        let byIdentity = new Map();
        (dbA[dayKey] || []).forEach(t => byIdentity.set(taskIdentity(t), t));
        (dbB[dayKey] || []).forEach(ct => {
            let key = taskIdentity(ct);
            let existing = byIdentity.get(key);
            if (!existing || (ct.updatedAt || 0) > (existing.updatedAt || 0)) byIdentity.set(key, ct);
        });
        merged[dayKey] = Array.from(byIdentity.values());
    });

    // Pass 2: the SAME task can legitimately end up under two different
    // day-keys after pass 1 — e.g. this device carries a task over to today
    // at the same moment a cloud snapshot (predating that carryover, or
    // from another device that carried the same task over on ITS side)
    // still lists it under yesterday. Pass 1 only compares within one
    // day-key at a time and can't see that. A task belongs to exactly one
    // day: whichever day-key holds its most-recently-updated copy — moving
    // a task bumps its updatedAt (see carryOverIncompleteTodos in
    // planner.js) — so every older duplicate under a different day-key is
    // dropped here.
    let idToLatest = new Map(); // id -> { dayKey, updatedAt }
    Object.keys(merged).forEach(dayKey => {
        merged[dayKey].forEach(t => {
            if (!t.id) return; // no id to cross-check across days — leave text-matched fallback tasks alone
            let cur = idToLatest.get(t.id);
            if (!cur || (t.updatedAt || 0) > cur.updatedAt) idToLatest.set(t.id, { dayKey, updatedAt: t.updatedAt || 0 });
        });
    });
    Object.keys(merged).forEach(dayKey => {
        merged[dayKey] = merged[dayKey].filter(t => !t.id || idToLatest.get(t.id).dayKey === dayKey);
        if (merged[dayKey].length === 0) delete merged[dayKey];
    });

    return merged;
}

// Thin, side-effecting wrapper — kept so applyCloudData/catchUpPlannerFromCloud
// don't need to change: "merge this cloud snapshot onto whatever's local
// right now, and save it."
function mergePlannerDB(cloudPlannerDB) {
    if (!cloudPlannerDB || typeof cloudPlannerDB !== "object") return;
    savePlannerDB(mergePlannerDBs(getPlannerDB(), cloudPlannerDB));
}

// ----------------- OPPORTUNISTIC PLANNER CATCH-UP (wake-from-background) -----------------
// Called from checkDayRollover() (ui.js) the instant a day boundary is
// crossed — the exact moment carryOverIncompleteTodos() is about to decide
// which of yesterday's tasks are "incomplete". On mobile this is most
// often the moment the device wakes from sleep: the app backgrounded
// across midnight, another device may have pushed newer planner changes in
// the meantime, and the real-time listener (startCloudListener below) —
// still attached, but only reconnects once the network/tab actually
// resumes — hasn't necessarily delivered them yet. Waiting here for one
// bounded document fetch means carryOverIncompleteTodos() runs against the
// freshest data available in a reasonable time, not a stale local copy.
//
// Safe to call unconditionally and even redundantly: mergePlannerDB() is a
// pure newest-wins merge, so this firing AND the real-time listener firing
// again moments later with the same (or a newer) snapshot is harmless —
// merging the same or older data a second time changes nothing.
//
// Deliberately does NOT touch jee_last_sync — that flag gates the
// full-category apply (study logs, sleep log, etc., which aren't
// merge-safe the way planner now is). Bumping it here would make the
// real-time listener think those OTHER categories are already caught up
// when only planner actually was, and their own newer cloud changes would
// get silently skipped.
export async function catchUpPlannerFromCloud() {
    if (!currentUser || !initFirebaseIfNeeded()) return; // guest/offline — proceed on local data only
    try {
        let doc = await Promise.race([
            fbDb.collection("users").doc(currentUser.uid).get({ source: "server" }),
            new Promise((_, reject) => setTimeout(() => reject(new Error("planner catch-up timed out")), 5000))
        ]);
        if (!doc.exists) return;
        mergePlannerDB(doc.data().plannerDB);
    } catch (e) {
        // Offline, slow reconnect, or timed out — proceed with whatever's
        // local rather than blocking the rollover indefinitely. The
        // still-attached real-time listener and the next explicit/auto
        // sync remain the safety net; this is a best-effort head start,
        // not the only chance to catch up.
        console.log("Planner catch-up skipped:", e.message);
    }
}

// Shared by pullFromCloud (explicit, user-initiated) and the real-time
// listener below (automatic, from another device). Applies every synced
// category to local storage.
async function applyCloudData(data) {
    // BUG FIX: was `saveDB(data.studyDB || {})` — a wholesale overwrite that
    // discarded any local study/break minutes logged on THIS device after
    // whatever moment this cloud snapshot was captured. mergeStudyDBs()
    // combines the two (see its own comment above) instead of picking one
    // side wholesale — the same class of fix plannerDB already had.
    saveDB(mergeStudyDBs(getDB(), data.studyDB || {}));
    // BUG FIX: was `savePlannerDB(data.plannerDB || {})` — a wholesale
    // overwrite that discarded any local planner change (a carryover, a
    // toggle, a newly-added task) made after this cloud snapshot was taken.
    // mergePlannerDB() combines the two instead of picking one wholesale —
    // see its own comment above for the full story.
    mergePlannerDB(data.plannerDB || {});
    // BUG FIX: was `writeSleepLog(data.sleepLog)` — same wholesale-overwrite
    // problem, for the sleep log. mergeSleepLogs() keeps whichever side's
    // entry is more complete per date instead of always taking the cloud's.
    if (data.sleepLog) writeSleepLog(mergeSleepLogs(getSleepLog(), data.sleepLog));
    if (data.sleepPending !== undefined) setSleepPending(data.sleepPending);
    // BUG FIX: was `saveSyllabusProgress(data.syllabusProgress)` — same
    // wholesale-overwrite problem. mergeSyllabusProgress() OR-merges each
    // chapter's completion tags instead of letting an older cloud snapshot
    // silently un-mark something completed locally.
    if (data.syllabusProgress) saveSyllabusProgress(mergeSyllabusProgress(getSyllabusProgress(), data.syllabusProgress));
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
    try {
        let doc = await fbDb.collection("users").doc(currentUser.uid).get();
        if (!doc.exists) { alert("No cloud data saved yet — tap Save to Cloud first."); return; }
        let data = doc.data();
        // BUG FIX: the old confirm() ("This will REPLACE all study logs...")
        // described a wholesale overwrite that applyCloudData() no longer
        // does — every category is now MERGED with what's already on this
        // device (see applyCloudData's own comments), so there's nothing
        // left on this device to lose, and nothing left to ask permission
        // for.
        await applyCloudData(data);
        setRawFlag("jee_last_sync", (data.updatedAt || Date.now()).toString());
        setRawFlag("jee_pending_toast", "Synced with the cloud.");
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
        // BUG FIX: this used to confirm() "Cloud data was found for this
        // account. Load it onto this device now? This will replace the
        // study logs, planner tasks, and other data currently on this
        // device" whenever the device already had local data — a leftover
        // from when applyCloudData() was a destructive overwrite and this
        // confirm was the only thing standing between a user and losing
        // local work. applyCloudData() now MERGES every category instead
        // of replacing it (see its own comment), so there's nothing left to
        // lose by applying automatically — this confirm was exactly the
        // unexplained "new data found on the cloud" pop-up reported as
        // sync friction.
        await applyCloudData(data);
        setRawFlag("jee_last_sync", (data.updatedAt || Date.now()).toString());
        // BUG FIX: showToast() immediately followed by location.reload() never
        // actually appears — the toast <div> is appended to the DOM but the
        // reload wipes everything before the browser paints that frame, so
        // it's created and destroyed without ever being visible. Persisting
        // the message and showing it after the reload (via
        // showPendingToastIfAny(), called from main.js on init) guarantees
        // it's actually seen.
        setRawFlag("jee_pending_toast", "Synced with the cloud.");
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
        // BUG FIX: pushToCloud() now writes via a Firestore TRANSACTION
        // (see its own comment), not a plain set() — and transactions never
        // set hasPendingWrites the way a plain write does (they only
        // resolve once genuinely committed server-side), so this guard
        // alone could no longer recognize this tab's own push as an echo.
        // That let a successful push's own snapshot be misread as "new data
        // from another device," triggering an unnecessary merge + reload in
        // the middle of that same push and racing its jee_last_sync update
        // — reported as "Save failed: Write did not verify on the server."
        // pushInFlight is the explicit fix: set for the exact duration of
        // pushToCloud(), so every snapshot arriving during that window is
        // skipped outright, no timing assumptions needed. hasPendingWrites
        // stays as a second filter alongside it — still correct and useful
        // for any other plain (non-transactional) write this document might
        // ever receive.
        if (pushInFlight || doc.metadata.hasPendingWrites) return;
        let lastLocalSync = parseInt(getRawFlag("jee_last_sync") || "0", 10);
        if (lastLocalSync <= 0) return;
        let data = doc.data();
        let remoteUpdatedAt = data.updatedAt || 0;
        // Only react to a genuinely newer write from elsewhere — otherwise
        // this fires as an echo of our own pushToCloud() on this same tab.
        if (remoteUpdatedAt <= lastLocalSync) return;
        // BUG FIX: this used to confirm() "New data was saved to the cloud
        // from another device. Load it here now? This will replace local
        // data on this device." — surfacing as an unexplained pop-up
        // mid-session (reported: "an option pops up on the laptop like new
        // data found on the cloud or something"). Same reasoning as
        // autoLoadCloudDataIfNeeded above: applyCloudData() merges now, it
        // doesn't replace, so there's no local data at risk and nothing
        // left to ask permission for.
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
        showToast("Cloud Data Deleted.");
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

    // BUG FIX: this used to only check on a 2-hour setInterval tick, and
    // guarded with a flag keyed to *today's* date only
    // ("weekly_report_sent_" + todayKey). Two separate problems came from
    // that:
    // 1) It never checked immediately when the site was opened — only after
    //    sitting on an open tab for up to 2 more hours — so a user who
    //    opened the app on Sunday, glanced at it, and closed it again could
    //    easily miss the window entirely and never get that week's report.
    // 2) The per-day flag was written via two separate localStorage writes
    //    (setRawFlag(flagKey,...) then setRawFlag("..._last",...)) right
    //    after firing sendReportViaEmail() — not awaited, not atomic. If the
    //    interval fired again before those writes landed (or a second tab
    //    was open at the same time, or the day rolled over mid-check), the
    //    guard could be re-read as "not yet sent" a second time the same
    //    day, sending the same report again — matching "the email came in
    //    twice or thrice the same day."
    // Fixed by checking once immediately (covers "must send when the user
    // opens the website") AND on the periodic interval (covers a tab left
    // open across the boundary), both routed through the SAME idempotent
    // check below — it compares against "the last week/month a report was
    // actually sent for", not "did today already fire", so calling it any
    // number of times in the same week/month is always a no-op after the
    // first successful send. This also naturally catches up a missed week:
    // if the user didn't open the site on Sunday, the very next time they
    // do (any day before the *following* Sunday) still sends for the week
    // that just ended, using the most recent Sunday's data range.
    checkAutoReports();
    autoReportInterval = setInterval(checkAutoReports, 7200000);
}

// Most recent Sunday on/before `d` (today, if today IS Sunday) — this is
// "the week that just completed and is due to be reported."
function mostRecentSundayKey(d = new Date()) {
    let sunday = new Date(d);
    sunday.setDate(d.getDate() - d.getDay());
    return dateKeyFromWall(sunday.getTime());
}

// The most recently-COMPLETED calendar month's last day, as a full date key.
// If `d` itself is the last day of its month, that month counts as just
// completed today; otherwise the last completed month is the one before
// this one (day 0 of the current month = the last day of the previous one).
function lastCompletedMonthEndKey(d = new Date()) {
    let tomorrow = new Date(d);
    tomorrow.setDate(d.getDate() + 1);
    let monthAlreadyEnded = tomorrow.getMonth() !== d.getMonth();
    let ref = monthAlreadyEnded ? d : new Date(d.getFullYear(), d.getMonth(), 0);
    return dateKeyFromWall(ref.getTime());
}

function checkAutoReports() {
    if (!currentUser) return;
    let now = new Date();

    let sundayKey = mostRecentSundayKey(now);
    if (getRawFlag("weekly_report_sent_last") !== sundayKey) {
        sendReportViaEmail('weekly', true);
        setRawFlag("weekly_report_sent_last", sundayKey);
    }

    let monthEndKey = lastCompletedMonthEndKey(now);
    if (getRawFlag("monthly_report_sent_last") !== monthEndKey) {
        sendReportViaEmail('monthly', true);
        setRawFlag("monthly_report_sent_last", monthEndKey);
    }
}
