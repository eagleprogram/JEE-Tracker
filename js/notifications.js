import { getTodayKey, shiftDateByYears } from './utils.js';
import { getNotifSettings, saveNotifSettings, getPlannerDB, getRawFlag, setRawFlag, getExamYear, BASE_EXAM_YEAR, BASE_EXAM_DATES, getLastBackupAt } from './storage.js';
import { getTimerState, getSegmentElapsedMs } from './timer.js';
// Forward reference — ui.js lands in Step 7. Only called inside function
// bodies, safe once the full module graph is wired in main.js.
import { showToast, lockBodyScroll, unlockBodyScroll } from './ui.js';

// ----------------- ALARM PRIORITY RANKING -----------------
// Lower number = more urgent = rings first if two reminders are due at the
// same time (see the alarm-queue in ringPersistentAlarm()/stopAlarmLoop()
// below). Referenced from each notify() call site further down this file:
//   1 = Parent log reminder   (someone else — your parent — is waiting)
//   2 = Exam milestone        (fixed date, can't be rescheduled)
//   3 = Revision reminder
//   4 = Planner tasks pending
//   5 = Sleep / wind-down reminder (also notify()'s own default)
//   6 = Break overrun check-in
//   7 = Idle nudge
//   8 = Backup reminder       (pure housekeeping, least urgent)

// ----------------- SETTINGS UI -----------------
export function renderNotifSettingsUI() {
    let s = getNotifSettings();
    document.getElementById("notif-breakOverrun").checked = s.breakOverrun;
    document.getElementById("notif-breakThreshold").value = s.breakThresholdMin;
    document.getElementById("notif-plannerReminder").checked = s.plannerReminder;
    document.getElementById("notif-plannerReminderStartTime").value = s.plannerReminderStartTime;
    document.getElementById("notif-examMilestones").checked = s.examMilestones;
    document.getElementById("notif-idleNudge").checked = s.idleNudge;
    document.getElementById("notif-idleThreshold").value = s.idleThresholdMin;
    document.getElementById("notif-revisionReminder").checked = s.revisionReminder;
    document.getElementById("notif-revisionReminderTime").value = s.revisionReminderTime;
    document.getElementById("notif-sleepReminder").checked = s.sleepReminder;
    document.getElementById("notif-sleepReminderStartTime").value = s.sleepReminderStartTime;
    document.getElementById("notif-parentLogReminder").checked = s.parentLogReminder;
    document.getElementById("notif-parentLogReminderTime").value = s.parentLogReminderTime;
    document.getElementById("notif-backupReminder").checked = s.backupReminder;
    document.getElementById("notif-waterBreakReminder").checked = s.waterBreakReminder;
    document.getElementById("notif-waterBreakFrequency").value = s.waterBreakFrequencyMin;
    document.getElementById("notif-smRadioReminders").checked = s.smRadioReminders;
    updateNotifPermissionStatus();
}

export function saveNotifSettingsFromUI() {
    // BUG FIX: this used to just clamp to a min of 5 with no rounding, so a
    // typed value like 25 was saved and used as-is — the "every 15 min"
    // step on the input's spinner only affects the up/down arrows, it
    // never restricts what can be typed directly. Snapping any typed value
    // to the nearest multiple of 15 (min 15) here, and writing the snapped
    // number back into the field, is what actually enforces it.
    let waterFreqRaw = parseInt(document.getElementById("notif-waterBreakFrequency").value) || 30;
    let waterFreqSnapped = Math.min(180, Math.max(15, Math.round(waterFreqRaw / 15) * 15));
    document.getElementById("notif-waterBreakFrequency").value = waterFreqSnapped;
    let s = {
        enabled: getNotifSettings().enabled,
        breakOverrun: document.getElementById("notif-breakOverrun").checked,
        breakThresholdMin: Math.max(5, parseInt(document.getElementById("notif-breakThreshold").value) || 45),
        plannerReminder: document.getElementById("notif-plannerReminder").checked,
        plannerReminderStartTime: document.getElementById("notif-plannerReminderStartTime").value || "20:00",
        examMilestones: document.getElementById("notif-examMilestones").checked,
        idleNudge: document.getElementById("notif-idleNudge").checked,
        idleThresholdMin: Math.max(10, parseInt(document.getElementById("notif-idleThreshold").value) || 30),
        revisionReminder: document.getElementById("notif-revisionReminder").checked,
        revisionReminderTime: document.getElementById("notif-revisionReminderTime").value || "21:00",
        sleepReminder: document.getElementById("notif-sleepReminder").checked,
        sleepReminderStartTime: document.getElementById("notif-sleepReminderStartTime").value || "22:30",
        parentLogReminder: document.getElementById("notif-parentLogReminder").checked,
        parentLogReminderTime: document.getElementById("notif-parentLogReminderTime").value || "22:30",
        backupReminder: document.getElementById("notif-backupReminder").checked,
        waterBreakReminder: document.getElementById("notif-waterBreakReminder").checked,
        waterBreakFrequencyMin: waterFreqSnapped,
        smRadioReminders: document.getElementById("notif-smRadioReminders").checked
    };
    saveNotifSettings(s); showToast("Notification settings saved.");
    // A frequency/on-off change should take effect immediately for a water
    // reminder that's already running (mid-study-session), not just the
    // next time study is started — restart it against the freshly-saved
    // settings. No-op (and harmless) if a study session isn't active.
    if (waterReminderTimer) startWaterReminder();
}

export function updateNotifPermissionStatus() {
    let el = document.getElementById("notif-permission-status");
    if (!("Notification" in window)) { el.innerText = "Not supported."; return; }
    let s = getNotifSettings();
    if (Notification.permission === "granted" && s.enabled) el.innerText = "✅ OS notifications enabled.";
    else if (Notification.permission === "denied") el.innerText = "⛔ Blocked — enable in browser settings.";
    else el.innerText = "Toasts always work in-tab. Click below for OS pop-ups too.";
}

export function enableNotifications() {
    if (!("Notification" in window)) { alert("Unsupported."); return; }
    Notification.requestPermission().then(perm => {
        let s = getNotifSettings(); s.enabled = (perm === "granted"); saveNotifSettings(s);
        updateNotifPermissionStatus();
        if (perm === "granted") showToast("Notifications enabled!");
    });
}

// ----------------- ALARM (persistent, for critical pings) -----------------
// BUG FIX: this used to call `new (AudioContext)()` fresh on every single
// beep — every 1s for as long as the persistent alarm rings, and once more
// for every one-off toast-only notify(). Two problems with that:
// 1) A brand-new AudioContext starts life "suspended" in browsers with
//    autoplay-restriction policies unless it's created/resumed inside a
//    direct user-gesture handler. A scheduled reminder firing from a
//    setInterval tick is NOT a user gesture, so a freshly-created context
//    can silently stay suspended and never actually produce sound — the
//    try/catch here doesn't even catch that, because creating the context
//    doesn't throw, it just does nothing audible. This is a strong
//    candidate for "the alarm modal shows but sometimes there's no sound"
//    reported while studying with the tab backgrounded.
// 2) Never closing any of those contexts leaves them piling up for the
//    lifetime of the tab — browsers cap how many concurrent AudioContexts a
//    page may hold, so a long study session with several alarms over the
//    day could eventually exhaust that cap and start failing outright.
// Fixed by reusing ONE lazily-created AudioContext for the whole page
// session and explicitly resume()-ing it before every beep (resume() on an
// already-running context is a harmless no-op) — same pattern browsers
// recommend for audio triggered by non-gesture events like timers.
let sharedAudioCtx = null;
export function playAlarmSound() {
    try {
        if (!sharedAudioCtx) sharedAudioCtx = new (window.AudioContext || window.webkitAudioContext)();
        let start = () => {
            let oscillator = sharedAudioCtx.createOscillator();
            let gainNode = sharedAudioCtx.createGain();
            oscillator.type = 'sine';
            oscillator.frequency.value = 800;
            oscillator.connect(gainNode);
            gainNode.connect(sharedAudioCtx.destination);
            gainNode.gain.setValueAtTime(0.3, sharedAudioCtx.currentTime);
            gainNode.gain.exponentialRampToValueAtTime(0.01, sharedAudioCtx.currentTime + 0.5);
            oscillator.start();
            oscillator.stop(sharedAudioCtx.currentTime + 0.5);
        };
        if (sharedAudioCtx.state === "suspended") {
            sharedAudioCtx.resume().then(start).catch(e => console.log("Audio resume failed", e));
        } else {
            start();
        }
    } catch (e) { console.log("Audio alarm failed", e); }
}

// Pre-warm/unlock the shared AudioContext on the very first real user
// gesture anywhere on the page (click, key press, or touch) — that's the
// one moment browsers reliably allow audio to be resumed, so doing it here
// means the context is already running long before an alarm ever needs to
// fire from a background timer tick, instead of trying (and sometimes
// failing) to resume it in that same non-gesture callback.
//
// BUG FIX: this used to run on the very first "click" event with no check
// on where it came from. The app itself fires several *synthetic* clicks
// during normal use — every download (Download Log, Download Report,
// backup export, mock-test attachments) creates a hidden <a> and calls
// a.click() on it to trigger the browser's save dialog. That synthetic
// click bubbles up to this document-level listener exactly like a real
// one, but it carries no real "user activation" as far as the browser's
// autoplay policy is concerned — so if a download happened to be the
// very first click of the session, the AudioContext got created/resumed
// outside a real gesture (silently failing to actually start, which is
// exactly the "AudioContext was not allowed to start" console warning),
// AND the listener still removed itself afterward, permanently skipping
// the real unlock for the rest of the session — meaning alarms could stay
// silent for the whole session even though the user did click things
// later. Checking event.isTrusted ignores script-dispatched clicks so
// only a genuine user gesture ever attempts the unlock.
function unlockAudioOnce(e) {
    if (e && e.isTrusted === false) return;
    try {
        if (!sharedAudioCtx) sharedAudioCtx = new (window.AudioContext || window.webkitAudioContext)();
        if (sharedAudioCtx.state === "suspended") sharedAudioCtx.resume().catch(() => {});
    } catch (e) { /* non-fatal — playAlarmSound will retry on its own */ }
    document.removeEventListener("click", unlockAudioOnce);
    document.removeEventListener("keydown", unlockAudioOnce);
    document.removeEventListener("touchstart", unlockAudioOnce);
}
document.addEventListener("click", unlockAudioOnce);
document.addEventListener("keydown", unlockAudioOnce);
document.addEventListener("touchstart", unlockAudioOnce);

let alarmInterval = null;
let isAlarmActive = false;

// BUG FIX: the alarm modal used to be one static, generic block ("ALARM
// RINGING! A critical notification requires your attention.") no matter
// which of the 6+ reminders (break overrun, idle nudge, exam milestone,
// backup, planner tasks, sleep, revision, parent log) actually fired it —
// so the one piece of information the alarm exists to convey (WHY it's
// ringing right now) was never shown. ringPersistentAlarm() now takes the
// same title/body every caller already builds for notify()/showToast()/the
// OS Notification and writes it straight into the modal's heading + reason
// line, so "Break check-in — You've been on break 47+ min" (etc.) is
// visible the instant the modal appears, not just buried in the toast that
// may have already faded by the time you look up.
// BUG FIX: the modal already shows one large 64px 🔔 above the title (see
// the alarm-modal markup in index.html), but this function was ALSO
// prefixing a small 🔔 onto the title text itself — so every reminder
// ("Revision reminder", etc.) rendered with two bells stacked on top of
// each other. The big icon is the only bell now; the title is plain text.
function setAlarmModalText(title, body) {
    let titleEl = document.getElementById("alarm-modal-title");
    let reasonEl = document.getElementById("alarm-modal-reason");
    if (titleEl) titleEl.innerText = title || "ALARM RINGING!";
    if (reasonEl) reasonEl.innerText = body || "A critical notification requires your attention.";
}

// ----------------- ALARM QUEUE (one at a time, most-important first) -----
// BUG FIX: previously, if a second reason fired while an alarm was already
// ringing, it just overwrote the modal's text in place — so e.g. a 9:00 PM
// Revision reminder and a 9:00 PM Parent-log reminder firing together meant
// whichever one's notify() call happened to run second silently replaced
// the first's text before you'd even had a chance to read/dismiss it, and
// the first reason was lost entirely. Reminders now carry a priority (lower
// = more urgent — see the notify() call sites below for the actual
// ranking), and a second reason that arrives while one is already ringing
// is queued instead of overwriting anything. The moment the current one is
// dismissed (stopAlarmLoop), the highest-priority queued reason immediately
// starts ringing on its own — sequential, never simultaneous/overwritten.
let alarmQueue = []; // { title, body, priority }
function enqueueAlarm(title, body, priority) {
    alarmQueue.push({ title, body, priority });
    // Array.prototype.sort is stable in every modern JS engine, so
    // same-priority reasons keep the order they actually fired in.
    alarmQueue.sort((a, b) => a.priority - b.priority);
}

// BUG FIX: a persistent alarm used to ring indefinitely until the user
// actively hit "Stop Alarm" — if they never did (phone in another room,
// asleep, etc.) it would just ring forever. Two changes:
// 1) Auto-silence after 2 minutes of continuous, unacknowledged ringing —
//    the sound+modal stop on their own instead of going forever.
// 2) Since auto-silencing (unlike a manual Stop) means the user still
//    hasn't actually acknowledged the reason, the same reason comes back
//    and rings again 5 minutes later — repeating this cycle until the user
//    does hit Stop, at which point stopAlarmLoop() below cancels the
//    pending re-ring (see alarmRelaunchTimer there).
const ALARM_AUTO_SILENCE_MS = 2 * 60 * 1000;
const ALARM_RERING_DELAY_MS = 5 * 60 * 1000;
let alarmAutoSilenceTimer = null;
let alarmRelaunchTimer = null;

export function ringPersistentAlarm(title, body, priority = 5) {
    if (isAlarmActive) { enqueueAlarm(title, body, priority); return; }
    isAlarmActive = true;
    setAlarmModalText(title, body);
    document.getElementById("alarm-modal").style.display = "flex";
    lockBodyScroll(); // block background scroll — shared counter, see ui.js
    playAlarmSound();
    alarmInterval = setInterval(() => { playAlarmSound(); }, 1000);
    startTitleFlash(title);
    alarmAutoSilenceTimer = setTimeout(() => autoSilenceAlarm(title, body, priority), ALARM_AUTO_SILENCE_MS);
}

// Called when 2 minutes pass with nobody tapping "Stop Alarm" — silences
// this ring (same cleanup as stopAlarmLoop(), minus the "Alarm stopped"
// toast, since the user didn't actually do anything) and schedules the
// same reason to ring again in 5 minutes. Any other reason already queued
// behind it still gets its turn first, exactly like a manual stop would.
function autoSilenceAlarm(title, body, priority) {
    if (alarmInterval) { clearInterval(alarmInterval); alarmInterval = null; }
    isAlarmActive = false;
    document.getElementById("alarm-modal").style.display = "none";
    unlockBodyScroll();
    stopTitleFlash();
    showToast(`"${title}" wasn't acknowledged — you'll be reminded again in 5 min.`);
    alarmRelaunchTimer = setTimeout(() => {
        alarmRelaunchTimer = null;
        ringPersistentAlarm(title, body, priority);
    }, ALARM_RERING_DELAY_MS);
    advanceAlarmQueue();
}

// Shared by autoSilenceAlarm() and stopAlarmLoop() — rings the next
// most-important queued reason (if any) after the standard breather gap.
function advanceAlarmQueue() {
    if (alarmQueue.length === 0) return;
    let next = alarmQueue.shift();
    showToast(`Next alarm ("${next.title}") in 15s…`);
    nextAlarmTimer = setTimeout(() => {
        nextAlarmTimer = null;
        ringPersistentAlarm(next.title, next.body, next.priority);
    }, ALARM_QUEUE_GAP_MS);
}

// Exposed so other modules (ui.js's guest sign-in reminder) can avoid
// popping their own full-screen modal on top of an alarm that's currently
// ringing or about to ring its next queued reason — see the "isAlarmRinging"
// check in maybeShowGuestSignInReminder() in ui.js.
export function isAlarmRinging() {
    return isAlarmActive || alarmQueue.length > 0 || nextAlarmTimer !== null;
}

let nextAlarmTimer = null;
// Gap (in ms) between dismissing one queued alarm and the next one ringing.
// Requested explicitly: give the user a moment to actually put the phone
// down / look away from the screen before the next reason starts blaring,
// rather than it slamming straight back on with zero breathing room.
const ALARM_QUEUE_GAP_MS = 15000;

export function stopAlarmLoop() {
    // A manual Stop IS acknowledgment — cancel the 2-min auto-silence timer
    // (nothing to silence anymore) and, importantly, the 5-min re-ring timer
    // if this ring was already an auto-silenced one coming back around, so
    // it doesn't ring a 3rd time after the user has just dismissed it.
    if (alarmAutoSilenceTimer) { clearTimeout(alarmAutoSilenceTimer); alarmAutoSilenceTimer = null; }
    if (alarmRelaunchTimer) { clearTimeout(alarmRelaunchTimer); alarmRelaunchTimer = null; }
    if (alarmInterval) { clearInterval(alarmInterval); alarmInterval = null; }
    isAlarmActive = false;
    document.getElementById("alarm-modal").style.display = "none";
    unlockBodyScroll();
    stopTitleFlash();
    showToast("Alarm stopped.");
    // Ring the next most-important queued reason after a short gap — this is
    // the "two (or more) reminders due at the same time" case: the more
    // important one rings, gets dismissed, then — after a 15-second
    // breather, not instantly — the next one rings in its own modal, and so
    // on down the queue. The OS notification for every queued reason
    // already went out the instant it became due (see notify()/
    // fireOsNotification below), so nothing about the alert itself is
    // delayed — only the in-page modal+sound is sequenced.
    advanceAlarmQueue();
}

// ----------------- TAB-TITLE FLASH -----------------
// Extra attention-grabber for the case where the tab is open and Chrome's JS
// timers are still actually running (so the alarm sound + modal genuinely
// did fire) but the tab itself isn't the focused one on screen — a second
// browser window, another tab in front, etc. Flashing the title is visible
// in the taskbar/tab-strip even then.
const BASE_TITLE = document.title;
let titleFlashInterval = null;
function startTitleFlash(reasonTitle) {
    if (titleFlashInterval) clearInterval(titleFlashInterval);
    let on = false;
    let flashText = reasonTitle ? `🔔 ${reasonTitle}!` : "🔔 Alarm!";
    titleFlashInterval = setInterval(() => {
        document.title = on ? BASE_TITLE : `${flashText} — ${BASE_TITLE}`;
        on = !on;
    }, 1000);
}
function stopTitleFlash() {
    if (titleFlashInterval) { clearInterval(titleFlashInterval); titleFlashInterval = null; }
    document.title = BASE_TITLE;
}

// ----------------- REAL OS NOTIFICATIONS (via the Service Worker) -------
// BUG FIX / ENHANCEMENT: previously the only "outside the tab" alert was
// `new Notification(...)` — a plain in-page Notification, which most
// browsers auto-dismiss after a few seconds, never vibrates, never shows an
// action button, and (critically) is NOT guaranteed to survive the tab
// itself being minimized/backgrounded on every platform. Notifications
// raised through the already-registered Service Worker
// (`registration.showNotification()`, sw.js) behave much more like a real
// app notification — WhatsApp-style: they land in the OS notification
// tray/lock screen, can be set to stay ("requireInteraction") until the
// user acts, can vibrate the device, and — this is the important part for
// "even if Chrome is minimized or another app is fullscreened over it" —
// they're delivered by the OS/browser notification system, not by this
// page's foreground rendering, so they still show even when this tab isn't
// the one on screen. Each distinct alarm reason gets its own OS
// notification (tag'd by title) so, like a chat app, several different
// reasons due around the same time each show up as their own banner in the
// tray — separate from the in-page queue above, which only governs the
// sound+modal experience for whichever tab is actually open.
//
// HONEST LIMIT (documented once here, not repeated at every call site):
// this only works while the browser process itself is alive somewhere —
// tab minimized, other app fullscreened over Chrome, phone screen off for a
// short while, etc. all still count as "alive" and this WILL ring/vibrate.
// If the OS has fully killed/discarded the browser process (force-closed
// from recents, device restarted, browser not running at all), no
// client-side code — this app or any other website — can wake it back up
// without a server-sent Push message, which this static, backend-less site
// doesn't have. That's a platform limitation, not something fixable here.
function fireOsNotification(title, body, persistent) {
    let s = getNotifSettings();
    if (!s.enabled || !("Notification" in window) || Notification.permission !== "granted") {
        if (persistent) maybeNudgeForOsNotifications();
        return;
    }
    let opts = {
        body,
        icon: "./assets/icon-192.png",
        badge: "./assets/icon-192.png",
        tag: "jee-alarm-" + String(title || "alert").toLowerCase().replace(/[^a-z0-9]+/g, "-"),
        renotify: true,
        requireInteraction: !!persistent,
        vibrate: persistent ? [300, 100, 300, 100, 300] : [150]
    };
    if (persistent) opts.actions = [{ action: "stop-alarm", title: "Stop Alarm" }];
    if ("serviceWorker" in navigator) {
        navigator.serviceWorker.ready.then((reg) => {
            if (reg && reg.showNotification) reg.showNotification(title || "Alert", opts).catch(() => fallbackPlainNotification(title, body));
            else fallbackPlainNotification(title, body);
        }).catch(() => fallbackPlainNotification(title, body));
    } else {
        fallbackPlainNotification(title, body);
    }
}
function fallbackPlainNotification(title, body) {
    try { new Notification(title || "Alert", { body }); } catch (e) {}
}

// Relays the "Stop Alarm" action tap (or a plain tap on the notification)
// from sw.js's notificationclick handler back into this running tab. If the
// app wasn't open at all, sw.js opens a fresh tab instead — there's no live
// page yet to receive a message in that case, so nothing to relay; the
// fresh load just boots normally (the OS notification itself already showed
// the reason, which was the actual point).
if ("serviceWorker" in navigator) {
    navigator.serviceWorker.addEventListener("message", (event) => {
        if (event.data && event.data.type === "STOP_ALARM") stopAlarmLoop();
    });
}

// ----------------- ONE-TIME OS-NOTIFICATION-PERMISSION NUDGE -----------
// The one thing that can reach the user when this tab isn't the one in
// front is a granted OS notification permission (see fireOsNotification's
// comment above). So the first time a persistent alarm fires without that
// permission granted, nudge toward turning it on — once only, tracked via a
// persisted flag so it doesn't repeat every alarm.
const NOTIF_HINT_SHOWN_KEY = "jee_notif_permission_hint_shown";
function maybeNudgeForOsNotifications() {
    if (!("Notification" in window) || Notification.permission === "denied") return;
    if (getRawFlag(NOTIF_HINT_SHOWN_KEY)) return;
    setRawFlag(NOTIF_HINT_SHOWN_KEY, "1");
    showToast("Tip: tap 'Enable Notifications' in Settings so alarms can still reach you when this tab isn't in front.");
}

// priority: lower number = more urgent = rings first when two reminders are
// queued up at once (see the alarm-queue comment above). Each call site
// below passes its own ranking; unset defaults to 5 (mid-priority).
export function notify(title, body, persistent = true, priority = 5) {
    showToast(body ? `${title} — ${body}` : title);
    fireOsNotification(title, body, persistent);
    if (persistent) { ringPersistentAlarm(title, body, priority); } else { playAlarmSound(); }
}

// ----------------- BREAK OVERRUN -----------------
let lastBreakNotifyAt = null;
export function checkBreakOverrun(s) {
    if (!s.breakOverrun) return;
    if (getTimerState() !== "BREAK") { lastBreakNotifyAt = null; return; }
    let elapsed = getSegmentElapsedMs();
    let thresholdMs = (s.breakThresholdMin || 45) * 60 * 1000;
    if (elapsed >= thresholdMs && (!lastBreakNotifyAt || Date.now() - lastBreakNotifyAt >= 10 * 60 * 1000)) {
        notify("Break check-in", `You've been on break ${Math.floor(elapsed/60000)}+ min — come back?`, true, 6);
        lastBreakNotifyAt = Date.now();
    }
}

// ----------------- IDLE NUDGE -----------------
// NEW IMPLEMENTATION — the original had full settings UI (idleNudge,
// idleThresholdMin) but no logic anywhere that read them. Nudges when the
// timer has sat IDLE (not studying, not on a break, not paused) for
// idleThresholdMin minutes straight, with a 30-minute cooldown between
// nudges so it doesn't repeat every second while runNotificationChecks() ticks.
let idleSinceMs = null;
let lastIdleNotifyAt = null;
function checkIdleNudge(s) {
    if (!s.idleNudge) { idleSinceMs = null; return; }
    if (getTimerState() !== "IDLE") { idleSinceMs = null; return; }
    if (idleSinceMs === null) { idleSinceMs = Date.now(); return; }
    let thresholdMs = (s.idleThresholdMin || 30) * 60 * 1000;
    let elapsed = Date.now() - idleSinceMs;
    if (elapsed >= thresholdMs && (!lastIdleNotifyAt || Date.now() - lastIdleNotifyAt >= 30 * 60 * 1000)) {
        notify("Still there?", `You've been idle for ${Math.floor(elapsed/60000)}+ min — start a session?`, true, 7);
        lastIdleNotifyAt = Date.now();
    }
}

// ----------------- EXAM MILESTONES -----------------
// NEW IMPLEMENTATION — same gap as idle nudge: settings existed, nothing
// checked them. Fires once per exam per milestone (30/7/1 days out), using
// the same exam-date math as ui.js's rebuildExamDates (BASE_EXAM_DATES
// shifted by the configured exam year), computed independently here so
// notifications.js doesn't need to depend on ui.js's internal state.
const EXAM_MILESTONE_DAYS = [30, 7, 1];
function checkExamMilestones(s) {
    if (!s.examMilestones) return;
    let yearOffset = getExamYear() - BASE_EXAM_YEAR;
    let exams = [
        { key: "mains1", label: "JEE Mains Session 1" },
        { key: "mains2", label: "JEE Mains Session 2" },
        { key: "adv", label: "JEE Advanced" }
    ];
    let now = Date.now();
    exams.forEach(({ key, label }) => {
        let examDate = shiftDateByYears(BASE_EXAM_DATES[key], yearOffset);
        let daysUntil = Math.ceil((examDate.getTime() - now) / 86400000);
        if (EXAM_MILESTONE_DAYS.includes(daysUntil)) {
            let flagKey = `jee_exam_milestone_${key}_${daysUntil}_${getTodayKey()}`;
            if (!getRawFlag(flagKey)) {
                notify("Exam milestone", `${label} is ${daysUntil} day${daysUntil === 1 ? '' : 's'} away.`, true, 2);
                setRawFlag(flagKey, "1");
            }
        }
    });
}

// ----------------- BACKUP REMINDER -----------------
// storage.js's markBackupDone() tracks the last-export timestamp; this
// reminds every 2 days (48h) if no fresh backup has been exported since.
// Toggle-able via s.backupReminder (Settings > Notifications), same as the
// other reminders.
//
// Cooldown is tracked as an actual "last reminded at" timestamp (not a
// per-calendar-day flag) so it holds for a true 48h window: the old
// per-day-flag version fired once on the day it first became due, then
// fired AGAIN the very next calendar day (still >=2 days since backup, new
// day = new flag) instead of waiting out the remaining ~24h. With a
// timestamp cooldown: once it fires, it stays silent until 48h after that
// firing, then fires again immediately on the next check afterwards
// (including right when the user next opens/signs into the app) — matching
// "if he didn't open the site, ring again right when he opens it."
// Exporting a backup calls markBackupDone(), which pushes `last` forward
// and makes the first condition below false again, resetting the whole cycle.
const BACKUP_REMINDER_INTERVAL_MS = 2 * 24 * 60 * 60 * 1000;
const BACKUP_REMINDER_LAST_KEY = "jee_backup_reminder_last_at";
function checkBackupReminder(s) {
    if (!s.backupReminder) return;
    let last = getLastBackupAt();
    if (!last) return; // main.js seeds this on first run; nothing to compare yet
    if (Date.now() - last < BACKUP_REMINDER_INTERVAL_MS) return; // backed up recently enough
    let lastReminded = parseInt(getRawFlag(BACKUP_REMINDER_LAST_KEY) || "0", 10);
    if (Date.now() - lastReminded < BACKUP_REMINDER_INTERVAL_MS) return; // already pinged within the last 48h
    notify("Backup reminder", "It's been 2+ days since your last backup — export one now from Settings.", true, 8);
    setRawFlag(BACKUP_REMINDER_LAST_KEY, String(Date.now()));
}

// ----------------- WATER BREAK REMINDER -----------------
// Unlike the other reminders above (which are all polled every second from
// runNotificationChecks()), this one runs its own dedicated interval that's
// only alive between "study started" and "sleep log saved" — see
// startWaterReminder()/stopWaterReminder()'s call sites in timer.js
// (confirmStartStudy()/resumeStudy()) and sleep.js (saveSleepLog()).
// Priority 6 — same tier as the break-overrun check-in, since both are
// "you're mid-study, here's a quick nudge" reminders.
let waterReminderTimer = null;
export function startWaterReminder() {
    if (waterReminderTimer) { clearInterval(waterReminderTimer); waterReminderTimer = null; }
    let s = getNotifSettings();
    if (!s.waterBreakReminder) return;
    // Defensive re-snap: a value saved before this fix (or edited directly
    // in storage) might not be a clean multiple of 15 — same snapping as
    // saveNotifSettingsFromUI() above, so this is never less than 15
    // regardless of what's actually sitting in storage.
    let ms = Math.min(180, Math.max(15, Math.round((s.waterBreakFrequencyMin || 30) / 15) * 15)) * 60 * 1000;
    waterReminderTimer = setInterval(() => {
        notify("Water break", "Time to drink some water!", true, 6);
    }, ms);
}
export function stopWaterReminder() {
    if (waterReminderTimer) { clearInterval(waterReminderTimer); waterReminderTimer = null; }
}

// ----------------- MASTER CHECK LOOP -----------------
// Called every second from main.js's tickCountdowns (matches original).
export function runNotificationChecks() {
    let s = getNotifSettings();
    let now = new Date();
    let h = now.getHours();
    let m = now.getMinutes();
    let minOfDay = h * 60 + m;

    // Planner reminder: user-configurable start time (default 8:00 PM), 2hr window, every 30 min
    // (same window+cadence shape as the sleep reminder below, just 2hr/30min instead of 30min/5min —
    // previously this pinged every 30 min indefinitely from the start time with no end).
    if (s.plannerReminder) {
        let [ph, pm2] = (s.plannerReminderStartTime || "20:00").split(":").map(n => parseInt(n, 10));
        let startMin = ph * 60 + pm2;
        let endMin = startMin + 120;
        if (minOfDay >= startMin && minOfDay <= endMin && (minOfDay - startMin) % 30 === 0) {
            let lastKey = "jee_planner_reminder_last_" + getTodayKey();
            let last = parseInt(getRawFlag(lastKey) || "0", 10);
            if (Date.now() - last > 30 * 60 * 1000) {
                let plannerDB = getPlannerDB();
                let tasks = plannerDB[getTodayKey()] || [];
                let pending = tasks.filter(t => !t.done).length;
                if (pending > 0) {
                    notify("Today's tasks", `${pending} task(s) pending!`, true, 4);
                    setRawFlag(lastKey, String(Date.now()));
                }
            }
        }
    }

    // Sleep reminder: user-configurable start time (default 10:30 PM), 30-min window, every 5 min
    if (s.sleepReminder) {
        let [sh, sm] = (s.sleepReminderStartTime || "22:30").split(":").map(n => parseInt(n, 10));
        let sleepStartMin = sh * 60 + sm;
        let sleepEndMin = sleepStartMin + 30;
        if (minOfDay >= sleepStartMin && minOfDay <= sleepEndMin && (minOfDay - sleepStartMin) % 5 === 0) {
            let lastKey = "jee_sleep_reminder_last_" + getTodayKey();
            let last = parseInt(getRawFlag(lastKey) || "0", 10);
            if (Date.now() - last > 5 * 60 * 1000) {
                notify("Wind down", `Past ${s.sleepReminderStartTime} - start winding down!`, true, 5);
                setRawFlag(lastKey, String(Date.now()));
            }
        }
    }

    // Revision reminder: user-configurable time (default 9:00 PM), once/day.
    // BUG FIX: this used to require `h === rh && m === rm` — an exact
    // single-minute match. runNotificationChecks() only runs when
    // tickCountdowns' setInterval fires, and Chrome (and most browsers)
    // throttle timers in background/hidden tabs to roughly once a minute —
    // exactly the "studying with the tab in the background" case reported.
    // Under that throttling the one tick that lands in a given minute can
    // easily drift a few seconds either side of when the browser *would*
    // have fired at the top of the target minute, and on a rough minute it
    // can skip a whole minute's tick entirely — so the single exact-minute
    // window this depended on is missed and the reminder silently never
    // fires that day. Switched to the same "at-or-past the target time,
    // fire once, flag it" catch-up pattern already used by the planner and
    // sleep reminders above: any check that runs at or after the target
    // minute (even if the exact minute was skipped) still fires it once.
    if (s.revisionReminder) {
        let [rh, rm] = (s.revisionReminderTime || "21:00").split(":").map(n => parseInt(n, 10));
        let targetMin = rh * 60 + rm;
        if (minOfDay >= targetMin) {
            let flagKey = "jee_revision_reminder_" + getTodayKey();
            if (!getRawFlag(flagKey)) {
                notify("Revision reminder", `${s.revisionReminderTime} - Quick revision pass!`, true, 3);
                setRawFlag(flagKey, "1");
            }
        }
    }

    // Parent log reminder: user-configurable time (default 10:30 PM), once/day.
    // Same exact-minute → catch-up fix as the revision reminder above.
    if (s.parentLogReminder) {
        let [lh, lm] = (s.parentLogReminderTime || "22:30").split(":").map(n => parseInt(n, 10));
        let targetMin = lh * 60 + lm;
        if (minOfDay >= targetMin) {
            let flagKey = "jee_parentlog_reminder_" + getTodayKey();
            if (!getRawFlag(flagKey)) {
                notify("Daily log", "Send today's study log to your parent.", true, 1);
                setRawFlag(flagKey, "1");
            }
        }
    }

    checkBreakOverrun(s);
    checkIdleNudge(s);
    checkExamMilestones(s);
    checkBackupReminder(s);
}
