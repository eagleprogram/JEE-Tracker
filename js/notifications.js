import { getTodayKey, shiftDateByYears } from './utils.js';
import { getNotifSettings, saveNotifSettings, getPlannerDB, getRawFlag, setRawFlag, getExamYear, BASE_EXAM_YEAR, BASE_EXAM_DATES, getLastBackupAt } from './storage.js';
import { getTimerState, getSegmentElapsedMs } from './timer.js';
// Forward reference — ui.js lands in Step 7. Only called inside function
// bodies, safe once the full module graph is wired in main.js.
import { showToast } from './ui.js';

// ----------------- SETTINGS UI -----------------
export function renderNotifSettingsUI() {
    let s = getNotifSettings();
    document.getElementById("notif-breakOverrun").checked = s.breakOverrun;
    document.getElementById("notif-breakThreshold").value = s.breakThresholdMin;
    document.getElementById("notif-plannerReminder").checked = s.plannerReminder;
    document.getElementById("notif-examMilestones").checked = s.examMilestones;
    document.getElementById("notif-idleNudge").checked = s.idleNudge;
    document.getElementById("notif-idleThreshold").value = s.idleThresholdMin;
    document.getElementById("notif-revisionReminder").checked = s.revisionReminder;
    document.getElementById("notif-sleepReminder").checked = s.sleepReminder;
    document.getElementById("notif-parentLogReminder").checked = s.parentLogReminder;
    document.getElementById("notif-backupReminder").checked = s.backupReminder;
    updateNotifPermissionStatus();
}

export function saveNotifSettingsFromUI() {
    let s = {
        enabled: getNotifSettings().enabled,
        breakOverrun: document.getElementById("notif-breakOverrun").checked,
        breakThresholdMin: Math.max(5, parseInt(document.getElementById("notif-breakThreshold").value) || 45),
        plannerReminder: document.getElementById("notif-plannerReminder").checked,
        examMilestones: document.getElementById("notif-examMilestones").checked,
        idleNudge: document.getElementById("notif-idleNudge").checked,
        idleThresholdMin: Math.max(10, parseInt(document.getElementById("notif-idleThreshold").value) || 30),
        revisionReminder: document.getElementById("notif-revisionReminder").checked,
        sleepReminder: document.getElementById("notif-sleepReminder").checked,
        parentLogReminder: document.getElementById("notif-parentLogReminder").checked,
        backupReminder: document.getElementById("notif-backupReminder").checked
    };
    saveNotifSettings(s); showToast("Notification settings saved.");
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
export function playAlarmSound() {
    try {
        let audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        let oscillator = audioCtx.createOscillator();
        let gainNode = audioCtx.createGain();
        oscillator.type = 'sine';
        oscillator.frequency.value = 800;
        oscillator.connect(gainNode);
        gainNode.connect(audioCtx.destination);
        gainNode.gain.setValueAtTime(0.3, audioCtx.currentTime);
        gainNode.gain.exponentialRampToValueAtTime(0.01, audioCtx.currentTime + 0.5);
        oscillator.start();
        oscillator.stop(audioCtx.currentTime + 0.5);
    } catch (e) { console.log("Audio alarm failed", e); }
}

let alarmInterval = null;
let isAlarmActive = false;

export function ringPersistentAlarm() {
    if (isAlarmActive) return; // Prevent overlapping alarms
    isAlarmActive = true;
    document.getElementById("alarm-modal").style.display = "flex";
    document.body.style.overflow = 'hidden'; // block background scroll
    playAlarmSound();
    alarmInterval = setInterval(() => { playAlarmSound(); }, 1000);
}

export function stopAlarmLoop() {
    if (alarmInterval) { clearInterval(alarmInterval); alarmInterval = null; }
    isAlarmActive = false;
    document.getElementById("alarm-modal").style.display = "none";
    document.body.style.overflow = '';
    showToast("Alarm stopped.");
}

export function notify(title, body, persistent = true) {
    if (persistent) { ringPersistentAlarm(); } else { playAlarmSound(); }
    showToast(body ? `${title} — ${body}` : title);
    let s = getNotifSettings();
    if (s.enabled && "Notification" in window && Notification.permission === "granted") {
        try { new Notification(title, { body }); } catch (e) {}
    }
}

// ----------------- BREAK OVERRUN -----------------
let lastBreakNotifyAt = null;
export function checkBreakOverrun(s) {
    if (!s.breakOverrun) return;
    if (getTimerState() !== "BREAK") { lastBreakNotifyAt = null; return; }
    let elapsed = getSegmentElapsedMs();
    let thresholdMs = (s.breakThresholdMin || 45) * 60 * 1000;
    if (elapsed >= thresholdMs && (!lastBreakNotifyAt || Date.now() - lastBreakNotifyAt >= 10 * 60 * 1000)) {
        notify("Break check-in", `You've been on break ${Math.floor(elapsed/60000)}+ min — come back?`);
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
        notify("Still there?", `You've been idle for ${Math.floor(elapsed/60000)}+ min — start a session?`);
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
                notify("Exam milestone", `${label} is ${daysUntil} day${daysUntil === 1 ? '' : 's'} away.`);
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
    notify("Backup reminder", "It's been 2+ days since your last backup — export one now from Settings.");
    setRawFlag(BACKUP_REMINDER_LAST_KEY, String(Date.now()));
}

// ----------------- MASTER CHECK LOOP -----------------
// Called every second from main.js's tickCountdowns (matches original).
export function runNotificationChecks() {
    let s = getNotifSettings();
    let now = new Date();
    let h = now.getHours();
    let m = now.getMinutes();
    let minOfDay = h * 60 + m;

    // Planner reminder: 8:00 PM onward, every 30 min
    if (s.plannerReminder && h >= 20 && m % 30 === 0) {
        let lastKey = "jee_planner_reminder_last_" + getTodayKey();
        let last = parseInt(getRawFlag(lastKey) || "0", 10);
        if (Date.now() - last > 30 * 60 * 1000) {
            let plannerDB = getPlannerDB();
            let tasks = plannerDB[getTodayKey()] || [];
            let pending = tasks.filter(t => !t.done).length;
            if (pending > 0) {
                notify("Today's tasks", `${pending} task(s) pending!`);
                setRawFlag(lastKey, String(Date.now()));
            }
        }
    }

    // Sleep reminder: 10:30 to 11:00 PM, every 5 minutes
    if (s.sleepReminder && minOfDay >= (22*60+30) && minOfDay <= (23*60) && m % 5 === 0) {
        let lastKey = "jee_sleep_reminder_last_" + getTodayKey();
        let last = parseInt(getRawFlag(lastKey) || "0", 10);
        if (Date.now() - last > 5 * 60 * 1000) {
            notify("Wind down", "Past 10:30 PM - start winding down!");
            setRawFlag(lastKey, String(Date.now()));
        }
    }

    // Revision reminder: 9:00 PM exactly
    if (s.revisionReminder && h === 21 && m === 0) {
        let flagKey = "jee_revision_reminder_" + getTodayKey();
        if (!getRawFlag(flagKey)) {
            notify("Revision reminder", "9 PM - Quick revision pass!");
            setRawFlag(flagKey, "1");
        }
    }

    // Parent log reminder: 10:30 PM exactly
    if (s.parentLogReminder && h === 22 && m === 30) {
        let flagKey = "jee_parentlog_reminder_" + getTodayKey();
        if (!getRawFlag(flagKey)) {
            notify("Daily log", "Send today's study log to your parent.");
            setRawFlag(flagKey, "1");
        }
    }

    checkBreakOverrun(s);
    checkIdleNudge(s);
    checkExamMilestones(s);
    checkBackupReminder(s);
}
