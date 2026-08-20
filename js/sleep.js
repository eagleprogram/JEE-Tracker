import { formatDateDDMMYY, formatTime12Hour, fmtTime, fmtDuration, dateKeyFromWall, getTodayKey } from './utils.js';
import { getSleepLog, writeSleepLog, getSleepPending, setSleepPending, getNotifSettings } from './storage.js';
// Forward reference — ui.js lands in Step 7. Only called inside function
// bodies, safe once the full module graph is wired in main.js.
import { showToast } from './ui.js';
// Refreshes the missed-break time inputs' min/max the instant a wake time is
// saved, so History's "Add Missed Break" reflects it immediately without
// requiring the user to touch the history date picker first.
import { refreshMissedBreakConstraints } from './history.js';
// BUG FIX: the "how many questions did you solve" popup used to also fire
// when a WAKE time was saved (maybeAskQuestionsSolved(pending.date) below,
// old CASE 2a) — asking someone how many questions they'd solved seconds
// after they woke up made no sense (they haven't studied yet). It's still
// asked when a bedtime/full entry is saved (that's the moment the day's
// study is actually "closed out") — just no longer on a wake-only save.
import { maybeAskQuestionsSolved } from './questions.js';
// Wake-only saves now open the attendance reminder instead (see
// openAttendanceReminderModal() below) — forward reference, same pattern as
// the ui.js import above.
import { openPlannerModal } from './planner.js';
// Studying's water-break reminder (see startWaterReminder() in timer.js)
// runs until the night's sleep log is actually saved.
import { stopWaterReminder } from './notifications.js';

// A "pending" entry is always type 'sleep' now (bedtime logged, wake still
// to come). Older saved data may still have a leftover type:'wake' pending
// from before this fix — saveSleepLog() migrates any of those into a
// standalone completed entry the first time it runs, so this helper and the
// 'wake' pending path only exist to handle that one-time cleanup.
function pendingType(pending) { return pending ? (pending.type || 'sleep') : null; }

function expectedWakeDateFor(sleepDate, sleepTime) {
    let [sh] = sleepTime.split(':').map(Number);
    let isPM = sh >= 12;
    if (isPM) {
        let d = new Date(sleepDate + "T00:00:00");
        d.setDate(d.getDate() + 1);
        return dateKeyFromWall(d.getTime());
    }
    return sleepDate;
}

// Save today's complete sleep log (wake and sleep times)
export function saveSleepLog() {
    let wakeVal = document.getElementById("wake-time-input").value;
    let sleepVal = document.getElementById("sleep-time-input").value;
    if (!wakeVal && !sleepVal) {
        showToast("Please enter at least one time.");
        return;
    }
    // Real-life rule: you only ever log a wake time for the morning you
    // actually woke up in — so the wake field is AM-only (00:00–11:59).
    if (wakeVal) {
        let [wh] = wakeVal.split(':').map(Number);
        if (wh >= 12) {
            showToast("⚠️ Wake time must be in the AM (before noon).");
            return;
        }
    }

    let today = getTodayKey();
    let log = getSleepLog();
    let pending = getSleepPending();

    // One-time migration: a leftover type:'wake' pending from before this
    // fix should never block or get attached to a new entry — turn it into
    // a standalone completed entry (dash for the missing sleep side) so it
    // stops being "pending" at all, then continue as if there were no
    // pending entry.
    if (pending && pendingType(pending) === 'wake') {
        if (!log[pending.date]) {
            log[pending.date] = { sleepDate: null, sleepTime: null, wakeDate: pending.date, wakeTime: pending.time, durationMin: null };
            writeSleepLog(log);
        }
        setSleepPending(null);
        pending = null;
    }

    // CASE 1: Only Sleep time provided.
    // Always starts a brand-new pending sleep cycle. A standalone wake-only
    // entry (see CASE 2b) is saved as complete the moment it's logged, so
    // there is never a dangling wake entry left for a bedtime to wrongly
    // attach itself to — every bedtime you log is the start of a new night.
    if (sleepVal && !wakeVal) {
        let sleepDate = today;

        // Guard 1: a bedtime that's still PENDING (no wake time logged for
        // it yet) — there's only one pending slot, so a second bedtime
        // right now would either silently overwrite it (losing it) or
        // create a confusing duplicate "waiting" row.
        if (pending && pendingType(pending) === 'sleep') {
            if (pending.date === sleepDate) {
                showToast("⚠️ You already have a bedtime pending — log your wake time to complete it, or cancel it (✕ on the banner) first.");
                return;
            }
            // Pending is from an earlier, different date (a forgotten
            // night) — logging a new one now would otherwise silently
            // discard it via the overwrite below, so confirm first.
            let ok = confirm(`You still have a bedtime pending from ${formatDateDDMMYY(pending.date)} with no wake time logged yet. Log a new bedtime now anyway and discard that old pending entry?`);
            if (!ok) return;
        }

        // Guard 2: cap at 2 completed sleep entries per calendar date — a
        // genuine early-AM one (e.g. 12:17 AM → 8:26 AM) plus a genuine
        // nighttime one (e.g. 10:58 PM → next morning) both legitimately
        // share the same sleepDate. A 3rd is never a real third "sleep" for
        // the same day — that's what the Break timer is for (a nap
        // mid-study), not the Sleep/Wake log.
        let sameDateCount = Object.values(log).filter(e => e.sleepDate === sleepDate).length;
        if (sameDateCount >= 2) {
            showToast("⚠️ You've already logged 2 sleep entries for this date (the max — one AM, one PM). For a nap, use the Break timer instead. Delete one in History first if you really need to redo it.");
            return;
        }

        let expectedWakeDate = expectedWakeDateFor(sleepDate, sleepVal);
        setSleepPending({ type: 'sleep', date: sleepDate, time: sleepVal, expectedWakeDate });
        document.getElementById("wake-time-input").value = "";
        document.getElementById("sleep-time-input").value = "";
        renderSleepLog();
        renderSleepPendingBanner();
        showToast("Bedtime logged — log your wake time to complete it.");
        // Bedtime logged = today's study day is effectively "closed out" —
        // this is the natural moment to ask how many questions were solved
        // today, then chain into the night's Questions Solved → Attendance
        // → (Tomorrow's) Planner flow. No-ops straight to the attendance
        // step if today was already asked (see the function).
        maybeAskQuestionsSolved(sleepDate, openEveningAttendanceReminderModal);
        // Going to sleep is the "sleep log saved" moment the water-break
        // reminder is scoped to stop at — no point nudging someone to drink
        // water while they're asleep.
        stopWaterReminder();
        return;
    }

    // CASE 2: Only Wake time provided.
    if (wakeVal && !sleepVal) {
        // 2a: A sleep time is already pending — this is the original
        // "complete the pending bedtime" flow.
        if (pending && pendingType(pending) === 'sleep') {
            let expectedWakeDate = pending.expectedWakeDate || expectedWakeDateFor(pending.date, pending.time);

            let sleepDateTime = new Date(pending.date + "T" + pending.time + ":00");
            let wakeDateTime = new Date(expectedWakeDate + "T" + wakeVal + ":00");
            let diffMin = Math.round((wakeDateTime - sleepDateTime) / 60000);

            if (diffMin <= 0 || diffMin > 20 * 60) {
                showToast("⚠️ Wake time seems wrong — can't go backward or sleep more than 20 hours. Please check.");
                return;
            }

            log[expectedWakeDate] = {
                sleepDate: pending.date,
                sleepTime: pending.time,
                wakeDate: expectedWakeDate,
                wakeTime: wakeVal,
                durationMin: diffMin
            };
            writeSleepLog(log);
            setSleepPending(null);
            refreshMissedBreakConstraints();
            showToast("Sleep log completed!");
        } else {
            // 2b: Nothing pending — the realistic first-time-opening-the-app
            // case (no prior bedtime on record to attach to). Save this as
            // a standalone COMPLETE entry immediately, with a dash for the
            // sleep side, instead of leaving it "pending" — that way a
            // bedtime logged later today is never mistaken for this
            // morning's counterpart, and always starts fresh (CASE 1).
            log[today] = { sleepDate: null, sleepTime: null, wakeDate: today, wakeTime: wakeVal, durationMin: null };
            writeSleepLog(log);
            refreshMissedBreakConstraints();
            showToast("Wake time logged (no bedtime on record for last night).");
        }
        document.getElementById("wake-time-input").value = "";
        document.getElementById("sleep-time-input").value = "";
        renderSleepLog();
        renderSleepPendingBanner();
        // A wake-up log (either sub-case above) is the trigger for the
        // morning attendance reminder — see openAttendanceReminderModal()
        // below. The day's to-do planner no longer opens from here; it now
        // opens at night instead (see openEveningAttendanceReminderModal()),
        // for tomorrow — see the Settings decision this was built against.
        if (getNotifSettings().smRadioReminders) openAttendanceReminderModal();
        return;
    }

    // CASE 3: Both times provided (Entering a past/retroactive entry safely)
    if (wakeVal && sleepVal) {
        let [sh, sm] = sleepVal.split(':').map(Number);
        let [wh, wm] = wakeVal.split(':').map(Number);
        let sleepMin = sh * 60 + sm;
        let wakeMin = wh * 60 + wm;
        let sleepDate = today;
        let wakeDate = today;
        let durationMin;

        let isPM = sh >= 12; // Night/afternoon sleep
        if (isPM) {
            // Slept at night PM → woke next day
            let d = new Date(today + "T00:00:00");
            d.setDate(d.getDate() + 1);
            wakeDate = dateKeyFromWall(d.getTime());
            durationMin = (1440 - sleepMin) + wakeMin;
        } else {
            // Both AM — same-day nap or past-midnight sleep → same day wake
            durationMin = wakeMin - sleepMin;
        }

        if (durationMin <= 0 || durationMin > 20 * 60) {
            showToast("⚠️ These times don't make sense — wake time is before sleep time or more than 20 hours apart. Please check.");
            return;
        }

        log[wakeDate] = { sleepDate, sleepTime: sleepVal, wakeDate, wakeTime: wakeVal, durationMin };
        writeSleepLog(log);
        refreshMissedBreakConstraints();
        if (pending) setSleepPending(null);
        document.getElementById("wake-time-input").value = "";
        document.getElementById("sleep-time-input").value = "";
        renderSleepLog();
        renderSleepPendingBanner();
        showToast("Sleep log saved.");
        // Same night chain as CASE 1 above — Questions Solved → Attendance
        // → Tomorrow's Planner.
        maybeAskQuestionsSolved(sleepDate, openEveningAttendanceReminderModal);
        // Both times entered together still represents a completed sleep
        // log for the night (same as CASE 1's bedtime-only save) — stop the
        // water reminder here too.
        stopWaterReminder();
    }
}

// Fires after a wake time is saved (see CASE 2 above). A simple morning
// "mark yourself present" nudge — a single acknowledgment button. The
// to-do Planner no longer opens from here (see openEveningAttendanceReminderModal()
// below for where it now lives). Skippable entirely via the "SM Radio
// Reminders" toggle in Settings (checked before this is even called — see
// CASE 2 above).
export function openAttendanceReminderModal() {
    document.getElementById("attendance-reminder-modal").style.display = "flex";
}
export function closeAttendanceReminderModal() {
    document.getElementById("attendance-reminder-modal").style.display = "none";
}

// Fires at night once the "questions solved" step for the day is done (see
// maybeAskQuestionsSolved(sleepDate, openEveningAttendanceReminderModal) in
// CASE 1/3 above) — reminds the user to mark in SM Radio whether they
// completed today's tasks and 360R/440R. Skippable via the same "SM Radio
// Reminders" toggle in Settings, in which case this steps straight through
// to opening tomorrow's Planner. Either way, acknowledging it (or skipping
// it) opens tomorrow's to-do list in the Planner — the single daily
// planning touchpoint, moved here from the morning so tomorrow gets planned
// while today is still fresh, instead of first thing in a groggy morning.
export function openEveningAttendanceReminderModal() {
    if (!getNotifSettings().smRadioReminders) { openTomorrowPlanner(); return; }
    document.getElementById("evening-attendance-modal").style.display = "flex";
}
export function closeEveningAttendanceReminderModal() {
    document.getElementById("evening-attendance-modal").style.display = "none";
    openTomorrowPlanner();
}
function openTomorrowPlanner() {
    let d = new Date(getTodayKey() + "T00:00:00");
    d.setDate(d.getDate() + 1);
    openPlannerModal(dateKeyFromWall(d.getTime()));
}

// Shows a small banner with a ✕ button whenever a bedtime has been logged
// but the wake time hasn't come in yet, so a wrong entry can be cancelled
// immediately instead of only being fixable from History. (Wake-only
// entries no longer stay "pending" — see CASE 2b above — so this banner
// only ever shows a pending BEDTIME now.)
export function renderSleepPendingBanner() {
    let banner = document.getElementById("sleep-pending-banner");
    if (!banner) return;
    let pending = getSleepPending();
    if (!pending) { banner.style.display = "none"; banner.innerHTML = ""; return; }
    banner.style.display = "flex";
    let pType = pendingType(pending);
    let text = (pType === 'wake')
        ? `⏳ Pending: woke at ${formatTime12Hour(fmtTime(pending.time))} on ${formatDateDDMMYY(pending.date)} — waiting for your bedtime.`
        : `⏳ Pending: slept ${formatTime12Hour(fmtTime(pending.time))} on ${formatDateDDMMYY(pending.date)} — waiting for wake time.`;
    banner.innerHTML = `<span>${text}</span><button onclick="cancelPendingSleepLog()" title="Cancel this pending log" style="background:none; border:none; color:var(--danger); cursor:pointer; font-size:16px; padding:0 4px; flex-shrink:0;">✕</button>`;
}

export function cancelPendingSleepLog() {
    if (!confirm("Cancel this pending log entry?")) return;
    setSleepPending(null);
    renderSleepPendingBanner();
    showToast("Pending log cancelled.");
}

// Render today's log status (simple update of history if open)
export function renderSleepLog() {
    let cont = document.getElementById("sleep-history-container");
    if (cont.style.display !== "none") {
        renderSleepHistory();
    }
}

export function toggleSleepHistory() {
    let cont = document.getElementById("sleep-history-container");
    let opening = cont.style.display === "none";
    cont.style.display = opening ? "block" : "none";
    if (opening) renderSleepHistory();
}

// Render the history panel with AM/PM and single-line layout
export function renderSleepHistory() {
    let cont = document.getElementById("sleep-history-container");
    let log = getSleepLog();
    let pending = getSleepPending();
    let wakeDates = Object.keys(log).sort().reverse();

    if (wakeDates.length === 0 && !pending) { cont.innerHTML = "<div class='yt-history-empty'>No sleep logs yet.</div>"; return; }

    let html = `<div style="display:grid; grid-template-columns: 1fr auto 28px; gap:8px; font-weight:700; color:var(--muted); font-size:11px; padding:0 4px 6px; border-bottom:1px solid var(--border);">
        <span>Sleep → Wake</span><span>Duration</span><span></span>
    </div>`;

    if (pending) {
        let pType = pendingType(pending);
        let label = (pType === 'wake')
            ? `-- --:-- → ${formatDateDDMMYY(pending.date)} ${formatTime12Hour(pending.time)}`
            : `${formatDateDDMMYY(pending.date)} ${formatTime12Hour(pending.time)} → -- --:--`;
        html += `<div style="display:grid; grid-template-columns: 1fr auto 28px; gap:8px; padding:6px 4px; align-items:center; font-size:12px; color:var(--warning);">
            <span style="white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${label}</span>
            <span style="white-space:nowrap;">—</span>
            <span></span>
        </div>`;
    }

    html += wakeDates.map(wakeDate => {
        let e = log[wakeDate];
        let hasSleepSide = !!(e.sleepDate && e.sleepTime);

        // Block and highlight impossible old logs (PM->AM same date)
        if (hasSleepSide && e.sleepDate === wakeDate) {
            let sleepHour = parseInt(e.sleepTime.split(':')[0], 10);
            let wakeHour = parseInt(e.wakeTime.split(':')[0], 10);
            if (sleepHour >= 12 && wakeHour < 12) {
                let sleepTime = formatTime12Hour(fmtTime(e.sleepTime));
                let wakeTime = formatTime12Hour(fmtTime(e.wakeTime));
                return `<div style="display:grid; grid-template-columns: 1fr auto 28px; gap:8px; padding:6px 4px; align-items:center; font-size:12px; color:var(--danger); border-bottom:1px solid var(--border);">
                    <span style="white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">
                        ⚠️ Impossible Log: ${formatDateDDMMYY(e.sleepDate)} ${sleepTime} → ${formatDateDDMMYY(wakeDate)} ${wakeTime}
                    </span>
                    <span style="white-space:nowrap;">--</span>
                    <button onclick="deleteSleepLogEntry('${wakeDate}')" title="Delete" style="background:none; border:none; color:#ef4444; cursor:pointer; font-size:14px; padding:0;">✕</button>
                </div>`;
            }
        }

        let sleepLabel = hasSleepSide
            ? `${formatDateDDMMYY(e.sleepDate)} ${formatTime12Hour(fmtTime(e.sleepTime))}`
            : `-- --:--`;
        let wakeTime = formatTime12Hour(fmtTime(e.wakeTime));
        let durationLabel = (e.durationMin != null) ? fmtDuration(e.durationMin) : '--';

        return `<div style="display:grid; grid-template-columns: 1fr auto 28px; gap:8px; padding:6px 4px; align-items:center; font-size:12px; border-bottom:1px solid var(--border);">
            <span style="color:var(--text); white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">
                ${sleepLabel} → ${formatDateDDMMYY(wakeDate)} ${wakeTime}
            </span>
            <span style="color:var(--primary); font-weight:700; white-space:nowrap;">${durationLabel}</span>
            <button onclick="deleteSleepLogEntry('${wakeDate}')" title="Delete" style="background:none; border:none; color:#ef4444; cursor:pointer; font-size:14px; padding:0;">✕</button>
        </div>`;
    }).join('');
    cont.innerHTML = html;
}

export function deleteSleepLogEntry(wakeDate) {
    if (!confirm(`Delete the sleep log for ${wakeDate}?`)) return;
    let log = getSleepLog();
    if (!log[wakeDate]) return;
    delete log[wakeDate];
    writeSleepLog(log);
    renderSleepHistory();
    showToast("Sleep log entry deleted.");
}
