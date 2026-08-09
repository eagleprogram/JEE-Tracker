import { formatDateDDMMYYYY, formatTime12Hour, fmtTime, fmtDuration, dateKeyFromWall, getTodayKey } from './utils.js';
import { getSleepLog, writeSleepLog, getSleepPending, setSleepPending } from './storage.js';
// Forward reference — ui.js lands in Step 7. Only called inside function
// bodies, safe once the full module graph is wired in main.js.
import { showToast } from './ui.js';

// Save today's complete sleep log (wake and sleep times)
export function saveSleepLog() {
    let wakeVal = document.getElementById("wake-time-input").value;
    let sleepVal = document.getElementById("sleep-time-input").value;
    if (!wakeVal && !sleepVal) {
        showToast("Please enter at least one time.");
        return;
    }
    let today = getTodayKey();
    let log = getSleepLog();
    let pending = getSleepPending();

    // CASE 1: Only Sleep time provided (Creates a pending entry)
    if (sleepVal && !wakeVal) {
        let [sh] = sleepVal.split(':').map(Number);
        let isPM = sh >= 12;
        let sleepDate = today;
        let expectedWakeDate;
        if (isPM) {
            let d = new Date(today + "T00:00:00");
            d.setDate(d.getDate() + 1);
            expectedWakeDate = dateKeyFromWall(d.getTime());
        } else {
            expectedWakeDate = today;
        }
        setSleepPending({ date: sleepDate, time: sleepVal, expectedWakeDate });
        document.getElementById("wake-time-input").value = "";
        document.getElementById("sleep-time-input").value = "";
        renderSleepLog();
        renderSleepPendingBanner();
        showToast("Bedtime logged — log your wake time to complete it.");
        return;
    }

    // CASE 2: Only Wake time provided (Completes a pending sleep)
    if (wakeVal && !sleepVal) {
        if (pending) {
            // Safety: fallback if old pending entry lacks expectedWakeDate
            if (!pending.expectedWakeDate) {
                let [sh] = pending.time.split(':').map(Number);
                let isPM = sh >= 12;
                if (isPM) {
                    let d = new Date(today + "T00:00:00");
                    d.setDate(d.getDate() + 1);
                    pending.expectedWakeDate = dateKeyFromWall(d.getTime());
                } else {
                    pending.expectedWakeDate = today;
                }
            }

            let sleepDateTime = new Date(pending.date + "T" + pending.time + ":00");
            let wakeDateTime  = new Date(pending.expectedWakeDate + "T" + wakeVal + ":00");
            let diffMin = Math.round((wakeDateTime - sleepDateTime) / 60000);

            if (diffMin <= 0 || diffMin > 20 * 60) {
                showToast("⚠️ Wake time seems wrong — can't go backward or sleep more than 20 hours. Please check.");
                return;
            }

            log[pending.expectedWakeDate] = {
                sleepDate: pending.date,
                sleepTime: pending.time,
                wakeDate: pending.expectedWakeDate,
                wakeTime: wakeVal,
                durationMin: diffMin
            };
            writeSleepLog(log);
            setSleepPending(null);
            showToast("Sleep log completed!");
        } else {
            // No pending log found — logging a wake time alone without a
            // matching pending sleep time causes impossible dates.
            showToast("⚠️ No pending sleep log found. Please enter both Sleep and Wake times together.");
            return;
        }
        document.getElementById("wake-time-input").value = "";
        document.getElementById("sleep-time-input").value = "";
        renderSleepLog();
        renderSleepPendingBanner();
        return;
    }

    // CASE 3: Both times provided (Entering a past/retroactive entry safely)
    if (wakeVal && sleepVal) {
        let [sh, sm] = sleepVal.split(':').map(Number);
        let [wh, wm] = wakeVal.split(':').map(Number);
        let sleepMin = sh * 60 + sm;
        let wakeMin  = wh * 60 + wm;
        let sleepDate = today;
        let wakeDate  = today;
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
        if (pending) setSleepPending(null);
        document.getElementById("wake-time-input").value = "";
        document.getElementById("sleep-time-input").value = "";
        renderSleepLog();
        renderSleepPendingBanner();
        showToast("Sleep log saved.");
    }
}

// Shows a small banner with a ✕ button whenever a sleep time has been
// logged but the matching wake time hasn't come in yet, so a wrong entry
// can be cancelled immediately instead of only being fixable from History.
export function renderSleepPendingBanner() {
    let banner = document.getElementById("sleep-pending-banner");
    if (!banner) return;
    let pending = getSleepPending();
    if (!pending) { banner.style.display = "none"; banner.innerHTML = ""; return; }
    banner.style.display = "flex";
    banner.innerHTML = `<span>⏳ Pending: slept ${formatTime12Hour(fmtTime(pending.time))} on ${formatDateDDMMYYYY(pending.date)} — waiting for wake time.</span><button onclick="cancelPendingSleepLog()" title="Cancel this pending sleep log" style="background:none; border:none; color:var(--danger); cursor:pointer; font-size:16px; padding:0 4px; flex-shrink:0;">✕</button>`;
}

export function cancelPendingSleepLog() {
    if (!confirm("Cancel this pending sleep log entry?")) return;
    setSleepPending(null);
    renderSleepPendingBanner();
    showToast("Pending sleep log cancelled.");
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
    let today = getTodayKey(); // Required for fallback calculations

    if (wakeDates.length === 0 && !pending) { cont.innerHTML = "<div class='yt-history-empty'>No sleep logs yet.</div>"; return; }

    let html = `<div style="display:grid; grid-template-columns: 1fr auto 28px; gap:8px; font-weight:700; color:var(--muted); font-size:11px; padding:0 4px 6px; border-bottom:1px solid var(--border);">
        <span>Sleep → Wake</span><span>Duration</span><span></span>
    </div>`;

    if (pending) {
        let expectedWakeDate = pending.expectedWakeDate || pending.date;
        if (!pending.expectedWakeDate) {
            let [sh] = pending.time.split(':').map(Number);
            let isPM = sh >= 12;
            if (isPM) {
                let d = new Date(today + "T00:00:00");
                d.setDate(d.getDate() + 1);
                expectedWakeDate = dateKeyFromWall(d.getTime());
            } else {
                expectedWakeDate = today;
            }
        }
        html += `<div style="display:grid; grid-template-columns: 1fr auto 28px; gap:8px; padding:6px 4px; align-items:center; font-size:12px; color:var(--warning);">
            <span style="white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">
                ${formatDateDDMMYYYY(pending.date)} ${formatTime12Hour(pending.time)}
                → ${formatDateDDMMYYYY(expectedWakeDate)} --:--
            </span>
            <span style="white-space:nowrap;">—</span>
            <span></span>
        </div>`;
    }

    html += wakeDates.map(wakeDate => {
        let e = log[wakeDate];
        let sleepDate  = e.sleepDate || wakeDate;
        let sleepTime  = formatTime12Hour(fmtTime(e.sleepTime));
        let wakeTime   = formatTime12Hour(fmtTime(e.wakeTime));

        // Block and highlight impossible old logs (PM->AM same date)
        if (e.sleepDate === wakeDate && e.sleepTime && e.wakeTime) {
            let sleepHour = parseInt(e.sleepTime.split(':')[0], 10);
            let wakeHour = parseInt(e.wakeTime.split(':')[0], 10);
            if (sleepHour >= 12 && wakeHour < 12) {
                return `<div style="display:grid; grid-template-columns: 1fr auto 28px; gap:8px; padding:6px 4px; align-items:center; font-size:12px; color:var(--danger); border-bottom:1px solid var(--border);">
                    <span style="white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">
                        ⚠️ Impossible Log: ${formatDateDDMMYYYY(sleepDate)} ${sleepTime} → ${formatDateDDMMYYYY(wakeDate)} ${wakeTime}
                    </span>
                    <span style="white-space:nowrap;">--</span>
                    <button onclick="deleteSleepLogEntry('${wakeDate}')" title="Delete" style="background:none; border:none; color:#ef4444; cursor:pointer; font-size:14px; padding:0;">✕</button>
                </div>`;
            }
        }

        return `<div style="display:grid; grid-template-columns: 1fr auto 28px; gap:8px; padding:6px 4px; align-items:center; font-size:12px; border-bottom:1px solid var(--border);">
            <span style="color:var(--text); white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">
                ${formatDateDDMMYYYY(sleepDate)} ${sleepTime} → ${formatDateDDMMYYYY(wakeDate)} ${wakeTime}
            </span>
            <span style="color:var(--primary); font-weight:700; white-space:nowrap;">${fmtDuration(e.durationMin)}</span>
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
