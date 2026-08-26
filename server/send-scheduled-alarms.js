// ----------------------------------------------------------------------------
// JEE Tracker — Scheduled Push Alarm Sender
// ----------------------------------------------------------------------------
// Runs every ~5 minutes via ../.github/workflows/scheduled-alarms.yml (a free
// GitHub Actions cron job).
//
// WHY THIS EXISTS: js/notifications.js's alarm loop only runs inside an open
// browser tab (see the "HONEST LIMIT" comment there). To reach a device with
// the browser fully closed, something has to run on a schedule OUTSIDE the
// browser and push the alert in. This script is that "something" — it reads
// every signed-in user's notification settings + relevant data from
// Firestore (synced there already by js/firebase-sync.js's pushToCloud, on
// a ~30-minute auto-sync), decides which reminders are due right now, and
// sends them as FCM data-only push messages to that user's registered
// device(s) (js/push-notifications.js registers those tokens).
//
// WHAT THIS DOES NOT COVER: break-overrun and idle-nudge reminders need the
// *live* in-tab timer state (is a session actually running right now, since
// when) — that's never synced to Firestore in real time, so there's nothing
// for this script to check. Those two remain tab-only, same as before. Every
// other reminder type (revision, parent log, sleep, planner tasks pending,
// exam milestones, backup) is covered here.
//
// DEDUPE STATE: kept separate from the client's own localStorage flags —
// each user's Firestore doc gets a `serverNotifFlags` map this script owns,
// so a push sent by this script and a toast/alarm shown by an open tab never
// fight over the same "already notified" flag (a user could easily have
// this script fire while their laptop tab is also open and about to notify
// on its own next tick — both are fine, a customer just gets the same
// reminder from two channels within the same minute at worst).
// ----------------------------------------------------------------------------

const admin = require("firebase-admin");

// ----------------- INIT -----------------
// FIREBASE_SERVICE_ACCOUNT_JSON must be the *entire* contents of the service
// account JSON key file (Firebase Console > Project Settings > Service
// Accounts > Generate new private key), stored as a GitHub Actions secret.
// This key can read/write your whole Firestore database, so it must NEVER
// be committed to the repo — only ever passed in as a secret environment
// variable.
const svcJson = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
if (!svcJson) {
    console.error("FIREBASE_SERVICE_ACCOUNT_JSON is not set.");
    process.exit(1);
}
let serviceAccount;
try {
    serviceAccount = JSON.parse(svcJson);
} catch (e) {
    console.error("FIREBASE_SERVICE_ACCOUNT_JSON is not valid JSON:", e.message);
    process.exit(1);
}
admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();
const messaging = admin.messaging();

// ----------------- SETTINGS DEFAULTS (mirrors js/storage.js's NOTIF_DEFAULTS) -----------------
const NOTIF_DEFAULTS = {
    plannerReminder: true, plannerReminderStartTime: "20:00",
    examMilestones: true,
    revisionReminder: true, revisionReminderTime: "21:00",
    sleepReminder: false, sleepReminderStartTime: "22:30",
    parentLogReminder: true, parentLogReminderTime: "22:30",
    backupReminder: true
};

// ----------------- IST TIME HELPERS -----------------
// This app is built around IST (Asia/Kolkata, UTC+5:30) — see
// BASE_EXAM_DATES in js/storage.js, which is hardcoded to +05:30 for the
// same reason. Rather than trying to track each device's own timezone
// (never synced to Firestore today), this assumes IST for every user, same
// as the exam dates already do.
const IST_OFFSET_MIN = 330; // +05:30
function istNow() { return new Date(Date.now() + IST_OFFSET_MIN * 60000); }
function istMinuteOfDay(d) { return d.getUTCHours() * 60 + d.getUTCMinutes(); }
function istDateKey(d) {
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}
function parseHHMM(hhmm, fallback) {
    let [h, m] = String(hhmm || fallback).split(":").map(n => parseInt(n, 10));
    if (isNaN(h) || isNaN(m)) [h, m] = fallback.split(":").map(Number);
    return h * 60 + m;
}

// ----------------- EXAM MILESTONE DATES (mirrors js/storage.js) -----------------
const BASE_EXAM_YEAR = 2027;
const BASE_EXAM_DATES = { mains1: "2027-01-21T00:00:00+05:30", mains2: "2027-04-02T00:00:00+05:30", adv: "2027-05-17T00:00:00+05:30" };
const EXAM_MILESTONE_DAYS = [30, 7, 1];
function shiftDateByYears(iso, years) {
    let d = new Date(iso);
    d.setFullYear(d.getFullYear() + years);
    return d;
}

// priority: lower = more urgent — mirrors the ranking table at the top of
// js/notifications.js so a queued-alarm ordering (client side, if the app
// happens to also be open) stays consistent regardless of which channel
// sent it.
const PRIORITY = { parentLog: 1, examMilestone: 2, revision: 3, planner: 4, sleep: 5, backup: 8 };
const COOLDOWNS_MS = {
    sleep: 5 * 60 * 1000,      // matches the 5-min repeat cadence in js/notifications.js
    planner: 30 * 60 * 1000,   // matches the 30-min repeat cadence
    backup: 2 * 24 * 60 * 60 * 1000
};

// Builds the list of { key, title, body, priority } reminders due right now
// for one user's data. Never mutates anything — the caller decides what to
// actually send and updates dedupe flags only after a send attempt.
function computeDueReminders(data, flags, now) {
    let s = { ...NOTIF_DEFAULTS, ...(data.notifSettings || {}) };
    let minOfDay = istMinuteOfDay(now);
    let todayKey = istDateKey(now);
    let due = [];

    if (s.revisionReminder) {
        let targetMin = parseHHMM(s.revisionReminderTime, "21:00");
        if (minOfDay >= targetMin && flags[`revision_${todayKey}`] !== true) {
            due.push({ key: `revision_${todayKey}`, title: "Revision reminder", body: `${s.revisionReminderTime || "21:00"} - Quick revision pass!`, priority: PRIORITY.revision, once: true });
        }
    }

    if (s.parentLogReminder) {
        let targetMin = parseHHMM(s.parentLogReminderTime, "22:30");
        if (minOfDay >= targetMin && flags[`parentLog_${todayKey}`] !== true) {
            due.push({ key: `parentLog_${todayKey}`, title: "Daily log", body: "Send today's study log to your parent.", priority: PRIORITY.parentLog, once: true });
        }
    }

    if (s.sleepReminder) {
        let startMin = parseHHMM(s.sleepReminderStartTime, "22:30");
        let endMin = startMin + 30;
        let lastAt = flags.sleep_lastAt || 0;
        if (minOfDay >= startMin && minOfDay <= endMin && (Date.now() - lastAt) >= COOLDOWNS_MS.sleep) {
            due.push({ key: "sleep_lastAt", title: "Wind down", body: `Past ${s.sleepReminderStartTime || "22:30"} - start winding down!`, priority: PRIORITY.sleep, once: false });
        }
    }

    if (s.plannerReminder) {
        let startMin = parseHHMM(s.plannerReminderStartTime, "20:00");
        let endMin = startMin + 120;
        let lastAt = flags.planner_lastAt || 0;
        if (minOfDay >= startMin && minOfDay <= endMin && (Date.now() - lastAt) >= COOLDOWNS_MS.planner) {
            let plannerDB = data.plannerDB || {};
            let tasks = plannerDB[todayKey] || [];
            let pending = tasks.filter(t => !t.done).length;
            if (pending > 0) {
                due.push({ key: "planner_lastAt", title: "Today's tasks", body: `${pending} task(s) pending!`, priority: PRIORITY.planner, once: false });
            }
        }
    }

    if (s.examMilestones) {
        let yearOffset = (data.examYear || BASE_EXAM_YEAR) - BASE_EXAM_YEAR;
        let exams = [
            { key: "mains1", label: "JEE Mains Session 1" },
            { key: "mains2", label: "JEE Mains Session 2" },
            { key: "adv", label: "JEE Advanced" }
        ];
        exams.forEach(({ key, label }) => {
            let examDate = shiftDateByYears(BASE_EXAM_DATES[key], yearOffset);
            let daysUntil = Math.ceil((examDate.getTime() - Date.now()) / 86400000);
            if (EXAM_MILESTONE_DAYS.includes(daysUntil)) {
                let flagKey = `examMilestone_${key}_${daysUntil}_${todayKey}`;
                if (flags[flagKey] !== true) {
                    due.push({ key: flagKey, title: "Exam milestone", body: `${label} is ${daysUntil} day${daysUntil === 1 ? "" : "s"} away.`, priority: PRIORITY.examMilestone, once: true });
                }
            }
        });
    }

    if (s.backupReminder) {
        let lastBackupAt = data.lastBackupAt || 0;
        let lastReminded = flags.backup_lastAt || 0;
        if (lastBackupAt > 0 && (Date.now() - lastBackupAt) >= COOLDOWNS_MS.backup && (Date.now() - lastReminded) >= COOLDOWNS_MS.backup) {
            due.push({ key: "backup_lastAt", title: "Backup reminder", body: "It's been 2+ days since your last backup — export one now from Settings.", priority: PRIORITY.backup, once: false });
        }
    }

    return due;
}

async function pruneInvalidTokens(tokens, responses) {
    let bad = new Set();
    responses.forEach((r, i) => {
        if (!r.success) {
            let code = r.error && r.error.code;
            if (code === "messaging/registration-token-not-registered" || code === "messaging/invalid-registration-token") {
                bad.add(tokens[i]);
            }
        }
    });
    return tokens.filter(t => !bad.has(t));
}

async function processUser(doc) {
    let data = doc.data() || {};
    let tokens = Array.isArray(data.fcmTokens) ? data.fcmTokens.filter(Boolean) : [];
    if (tokens.length === 0) return { sent: 0, pruned: 0 }; // never enabled background push on any device

    let flags = data.serverNotifFlags || {};
    let now = istNow();
    let due = computeDueReminders(data, flags, now);
    if (due.length === 0) return { sent: 0, pruned: 0 };

    let flagUpdates = {};
    let sentCount = 0;
    let prunedCount = 0;

    for (const reminder of due) {
        let message = {
            tokens,
            data: {
                title: reminder.title,
                body: reminder.body,
                priority: String(reminder.priority),
                persistent: "1"
            }
        };
        try {
            let resp = await messaging.sendEachForMulticast(message);
            sentCount += resp.successCount;
            if (resp.failureCount > 0) {
                let survivors = await pruneInvalidTokens(tokens, resp.responses);
                if (survivors.length !== tokens.length) {
                    prunedCount += (tokens.length - survivors.length);
                    tokens = survivors;
                    flagUpdates.fcmTokens = survivors;
                }
            }
            // Mark this reminder as sent regardless of exact success count —
            // a partial failure (one dead token among several devices)
            // shouldn't cause the same reminder to be resent to the working
            // devices five minutes later.
            flagUpdates[`serverNotifFlags.${reminder.key}`] = reminder.once ? true : Date.now();
        } catch (e) {
            console.error(`  send failed for ${doc.id} / ${reminder.key}:`, e.message);
        }
    }

    if (Object.keys(flagUpdates).length > 0) {
        // fcmTokens (if pruned) needs a plain field write, not dot-notation —
        // split it out from the dot-notation serverNotifFlags.* updates.
        let { fcmTokens, ...dotUpdates } = flagUpdates;
        let updatePayload = { ...dotUpdates };
        if (fcmTokens) updatePayload.fcmTokens = fcmTokens;
        await doc.ref.update(updatePayload);
    }

    return { sent: sentCount, pruned: prunedCount };
}

async function main() {
    console.log(`[${new Date().toISOString()}] Scheduled alarm check starting...`);
    let usersSnap = await db.collection("users").get();
    console.log(`  ${usersSnap.size} user doc(s) found.`);

    let totalSent = 0, totalPruned = 0, usersNotified = 0, errors = 0;
    for (const doc of usersSnap.docs) {
        try {
            let { sent, pruned } = await processUser(doc);
            totalSent += sent;
            totalPruned += pruned;
            if (sent > 0) usersNotified++;
        } catch (e) {
            errors++;
            console.error(`  error processing user ${doc.id}:`, e.message);
        }
    }

    console.log(`Done. ${totalSent} push message(s) sent to ${usersNotified} user(s). ${totalPruned} dead token(s) pruned. ${errors} error(s).`);
}

main().catch((e) => {
    console.error("Fatal error:", e);
    process.exit(1);
});
