// ----------------- BACKGROUND PUSH (Firebase Cloud Messaging) -----------------
// Everything in notifications.js only works while the browser process is
// alive somewhere (tab minimized, another app fullscreened over it, etc —
// see the "HONEST LIMIT" comment in that file). This file adds the one
// channel that can also reach the user when the browser itself is fully
// closed or the device has been idle a while: a real Push message, delivered
// by Google's FCM infrastructure straight to the OS, which wakes this app's
// service worker just long enough to show the notification — no open tab,
// no running page JS required on this end at all.
//
// That alone isn't enough — something still has to actually DECIDE "it's
// 9pm, send the revision reminder" and call FCM's send API on a schedule.
// This static, backend-less site can't do that while nobody has it open. A
// tiny scheduled Node script (server/send-scheduled-alarms.js), triggered
// every 5 minutes by a free GitHub Actions cron job, is what does that half
// — see PUSH_SETUP.md for the one-time setup (all free, no credit card).
// This file is only the CLIENT half: getting this device's push token and
// handing it to that script (via Firestore) so it knows where to deliver.
//
// HONEST LIMIT (same category as notifications.js's, kept separate since
// it's specific to this channel): FCM delivery depends on the GitHub
// Actions cron actually running — GitHub explicitly does not guarantee
// exact timing (a few minutes' slip during high load is normal), and
// auto-disables a repo's scheduled workflows after 60 days with no commits
// to the repo at all (a `workflow_dispatch` run or any commit resets that
// clock — see PUSH_SETUP.md). It is NOT a literal 100%-guaranteed pager —
// nothing free and backend-less can promise that — but it closes the gap
// for the one case pure client-side code genuinely cannot cover: the
// browser fully closed.
import { getFirebaseApp, getFirebaseDb, getCurrentUser } from './firebase-sync.js';
import { showToast } from './ui.js';
import { getRawFlag, setRawFlag } from './storage.js';
import { ringPersistentAlarm } from './notifications.js';

// PASTE YOUR OWN VAPID PUBLIC KEY HERE — Firebase Console > (gear icon)
// Project Settings > Cloud Messaging tab > "Web configuration" > Web Push
// certificates > Generate key pair. Free, one-time, takes under a minute.
// Background push refuses to run with a clear message until this is set.
const VAPID_PUBLIC_KEY = "BEZiHF0XpYK52avaXS6nmlNbm9g8urt2zk_3zNtasGdogl5Uy_zIoFzIjQPtxeBxL2ETePhVCK_T5V6FgANfWPY";

const PUSH_ENABLED_FLAG = "jee_push_enabled";
let messaging = null;

function vapidConfigured() { return !!VAPID_PUBLIC_KEY && !VAPID_PUBLIC_KEY.startsWith("PASTE_"); }

function initMessagingIfNeeded() {
    if (messaging) return messaging;
    let app = getFirebaseApp();
    if (!app || typeof firebase === "undefined" || !firebase.messaging) return null;
    messaging = firebase.messaging();
    // Foreground messages (tab open AND focused right now) arrive HERE
    // instead of being auto-shown as an OS banner — deliberately, since the
    // server sends data-only payloads (see server/send-scheduled-alarms.js
    // and sw.js's onBackgroundMessage for why). Routing it into the exact
    // same ringPersistentAlarm() the local 1-second tick loop already uses
    // means the experience is identical no matter which path triggered it —
    // full modal + sound + queueing, not just a toast.
    messaging.onMessage((payload) => {
        let d = payload.data || {};
        ringPersistentAlarm(d.title || "Reminder", d.body || "", parseInt(d.priority, 10) || 5);
    });
    return messaging;
}

export function updatePushPermissionStatusUI() {
    let el = document.getElementById("push-permission-status");
    if (!el) return;
    if (!vapidConfigured()) { el.innerText = "Not set up yet on this deployment — see PUSH_SETUP.md."; return; }
    if (!("Notification" in window) || !("serviceWorker" in navigator)) { el.innerText = "Not supported on this browser."; return; }
    if (!getCurrentUser()) { el.innerText = "Sign in first — background alerts are tied to your account."; return; }
    if (Notification.permission === "denied") { el.innerText = "⛔ Blocked — enable notifications for this site in your browser settings."; return; }
    if (Notification.permission === "granted" && getRawFlag(PUSH_ENABLED_FLAG) === "1") { el.innerText = "✅ Background alerts enabled on this device."; return; }
    el.innerText = "Off. Tap Enable — alerts will then reach you even with the app fully closed.";
}

export async function enableBackgroundPush() {
    if (!vapidConfigured()) { alert("Background push isn't configured yet on this deployment. See PUSH_SETUP.md — it's a free, one-time setup."); return; }
    if (!getCurrentUser()) { alert("Sign in first — background alerts are saved to your account so the scheduled job knows where to send them."); return; }
    if (!("serviceWorker" in navigator) || !("Notification" in window)) { alert("Push notifications aren't supported on this browser."); return; }
    try {
        let perm = await Notification.requestPermission();
        if (perm !== "granted") { showToast("Notification permission not granted."); updatePushPermissionStatusUI(); return; }
        let reg = await navigator.serviceWorker.ready;
        let msg = initMessagingIfNeeded();
        if (!msg) { showToast("Push setup failed — try reloading the page."); return; }
        // BUG FIX: msg.useServiceWorker(reg) was removed from the Firebase JS
        // SDK starting in v9 (index.html loads v10.12.2) — calling it threw
        // "msg.useServiceWorker is not a function" immediately, before a
        // token was ever requested. The v9+ replacement is to pass the
        // registration straight into getToken()'s options instead.
        let token = await msg.getToken({ vapidKey: VAPID_PUBLIC_KEY, serviceWorkerRegistration: reg });
        if (!token) { showToast("Could not get a push token — try again in a moment."); return; }
        await saveTokenToCloud(token);
        setRawFlag(PUSH_ENABLED_FLAG, "1");
        showToast("Background alerts enabled on this device!");
        updatePushPermissionStatusUI();
    } catch (e) {
        console.log("enableBackgroundPush failed:", e);
        alert("Couldn't enable background alerts: " + e.message);
    }
}

// Wired to the "Disable" button — removes THIS device's token from
// Firestore (other signed-in devices, if any, keep working) and clears the
// local flag so reregisterPushIfEnabled() stops silently re-registering it.
export async function disableBackgroundPush() {
    setRawFlag(PUSH_ENABLED_FLAG, "0");
    try {
        let dbInst = getFirebaseDb();
        let user = getCurrentUser();
        let msg = initMessagingIfNeeded();
        if (dbInst && user && msg && "serviceWorker" in navigator) {
            let reg = await navigator.serviceWorker.ready;
            // Same v9+ fix as enableBackgroundPush() above — no useServiceWorker().
            let token = await msg.getToken({ vapidKey: VAPID_PUBLIC_KEY, serviceWorkerRegistration: reg }).catch(() => null);
            if (token) {
                await dbInst.collection("users").doc(user.uid).set(
                    { fcmTokens: firebase.firestore.FieldValue.arrayRemove(token) },
                    { merge: true }
                );
            }
        }
    } catch (e) { /* best-effort — the local flag is already cleared either way */ }
    showToast("Background alerts disabled on this device.");
    updatePushPermissionStatusUI();
}

async function saveTokenToCloud(token) {
    let dbInst = getFirebaseDb();
    let user = getCurrentUser();
    if (!dbInst || !user) return;
    await dbInst.collection("users").doc(user.uid).set(
        { fcmTokens: firebase.firestore.FieldValue.arrayUnion(token) },
        { merge: true }
    );
}

// Called once at boot (main.js, after the boot sign-in gate resolves) so a
// device that already enabled this earlier keeps its token registered.
// FCM tokens can rotate silently (browser update, storage cleared, etc.) —
// re-fetching and re-saving the current one is a harmless no-op when it
// hasn't changed, and quietly heals a rotated one without the user having
// to notice or re-click Enable.
export async function reregisterPushIfEnabled() {
    if (getRawFlag(PUSH_ENABLED_FLAG) !== "1") return;
    if (!vapidConfigured() || !getCurrentUser()) return;
    if (!("serviceWorker" in navigator) || Notification.permission !== "granted") return;
    try {
        let reg = await navigator.serviceWorker.ready;
        let msg = initMessagingIfNeeded();
        if (!msg) return;
        // Same v9+ fix as enableBackgroundPush() above — no useServiceWorker().
        let token = await msg.getToken({ vapidKey: VAPID_PUBLIC_KEY, serviceWorkerRegistration: reg });
        if (token) await saveTokenToCloud(token);
    } catch (e) { console.log("Silent push re-registration skipped:", e.message); }
}
