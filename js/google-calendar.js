// google-calendar.js — feature request: "add a Google account icon so a
// user's planner tasks appear in their own Google Calendar, and vice
// versa." This is a genuinely separate integration from the existing
// Account & Sync (Firebase Auth + Firestore) elsewhere in the app — that
// sync keeps this app's OWN data backed up across devices; this module
// talks to the real Google Calendar API using an OAuth token with the
// sensitive `calendar.events` scope (see firebase-sync.js) — the user's
// choice of real two-way sync with their ACTUAL calendar over the
// unlimited-access-but-app-only-calendar alternative that was tried and
// reverted (see SCOPE CHOICE comment on signInWithGoogle() in
// firebase-sync.js). That means every user needs to be added as a
// Testing-mode test user in Google Cloud Console — fine at this app's
// current handful-of-users scale (100-user cap), until/unless it's worth
// going through full Google verification later.
//
// Scope of what's implemented: pushes the next 7 days of planner tasks
// into the user's real primary Google Calendar as all-day events (tagged
// so re-syncing never creates duplicates), and lists the user's own
// upcoming real Google Calendar events underneath the Holiday Reference
// iframe. This is NOT a silent background two-way sync — see the HONEST
// LIMIT comment in firebase-sync.js on why the access token this depends
// on is short-lived (~1hr); a real always-on background sync would need a
// server-side refresh-token flow (the same shape as the existing FCM push
// job in server/), which is a much bigger project than this button —
// syncing happens on sign-in and whenever the icon is tapped, not
// continuously in the background.
import { getCurrentUser, connectGoogleCalendar, getGoogleCalendarAccessToken } from './firebase-sync.js';
import { getPlannerDB } from './storage.js';
import { getTodayKey, dateKeyFromWall } from './utils.js';
import { showToast } from './ui.js';

const CAL_EVENTS_URL = "https://www.googleapis.com/calendar/v3/calendars/primary/events";

async function ensureToken() {
    let token = getGoogleCalendarAccessToken();
    if (token) return token;
    return await connectGoogleCalendar();
}

// Pushes today + the next 6 days' planner tasks as all-day Calendar events
// onto the user's REAL primary calendar. Each event carries
// extendedProperties.private.jeeTrackerTaskId = the task's own id, so
// re-running this later (or after adding new tasks) skips anything
// already pushed instead of creating duplicates.
export async function syncPlannerToGoogleCalendar(token) {
    let plannerDB = getPlannerDB();
    let todayKey = getTodayKey();
    let keys = [];
    for (let i = 0; i < 7; i++) {
        let d = new Date(todayKey + "T00:00:00");
        d.setDate(d.getDate() + i);
        keys.push(dateKeyFromWall(d.getTime()));
    }

    let pushed = 0, skipped = 0, failed = 0;
    for (let key of keys) {
        let tasks = plannerDB[key] || [];
        for (let task of tasks) {
            try {
                let searchUrl = `${CAL_EVENTS_URL}?privateExtendedProperty=${encodeURIComponent("jeeTrackerTaskId=" + task.id)}`;
                let searchResp = await fetch(searchUrl, { headers: { Authorization: `Bearer ${token}` } });
                let searchData = await searchResp.json();
                if (searchData.items && searchData.items.length > 0) { skipped++; continue; }

                let body = {
                    summary: `📚 ${task.text}`,
                    description: `JEE Tracker planner task (${task.priority || "medium"} priority).`,
                    start: { date: key },
                    end: { date: key },
                    extendedProperties: { private: { jeeTrackerTaskId: task.id } }
                };
                let resp = await fetch(CAL_EVENTS_URL, {
                    method: "POST",
                    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
                    body: JSON.stringify(body)
                });
                if (resp.ok) pushed++; else failed++;
            } catch (e) { failed++; }
        }
    }
    return { pushed, skipped, failed };
}

// Renders the user's own real next-14-days Google Calendar events into
// #google-calendar-events, underneath the Holiday Reference iframe — the
// "vice versa" half of the sync.
export async function loadGoogleCalendarEvents(token) {
    let cont = document.getElementById("google-calendar-events");
    if (!cont) return;
    cont.innerHTML = `<div class="small-note">Loading your Google Calendar events…</div>`;
    try {
        let now = new Date();
        let end = new Date(now);
        end.setDate(end.getDate() + 14);
        let url = `${CAL_EVENTS_URL}?timeMin=${encodeURIComponent(now.toISOString())}&timeMax=${encodeURIComponent(end.toISOString())}&singleEvents=true&orderBy=startTime&maxResults=15`;
        let resp = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
        let data = await resp.json();
        let events = data.items || [];
        if (events.length === 0) {
            cont.innerHTML = `<div class="small-note">No upcoming events on your Google Calendar.</div>`;
            return;
        }
        cont.innerHTML = `<div class="small-note" style="margin-bottom:4px;">Your Google Calendar (next 14 days):</div>` + events.map(ev => {
            let when = ev.start && ev.start.dateTime ? new Date(ev.start.dateTime).toLocaleString() : (ev.start ? ev.start.date : "");
            let title = ev.summary || "(untitled)";
            return `<div class="stat-row"><span>${title}</span><span style="color:var(--muted); font-size:11px;">${when}</span></div>`;
        }).join("");
    } catch (e) {
        cont.innerHTML = `<div class="small-note" style="color:var(--danger);">Couldn't load your events: ${e.message}</div>`;
    }
}

// Wired to the Google icon button in the Holiday Reference card
// (index.html), and auto-run right after a fresh sign-in that granted
// Calendar access (see firebase-sync.js). One call: connect (or reuse an
// already-connected session), push this week's planner tasks out, pull
// the user's own real events back in.
export async function connectAndSyncGoogleCalendar() {
    if (!getCurrentUser()) {
        alert("Sign in with Google first — see Account & Sync in the sidebar — then tap this icon again to connect your Calendar.");
        return;
    }
    let token = await ensureToken();
    if (!token) return;
    showToast("Syncing with Google Calendar…");
    let { pushed, skipped, failed } = await syncPlannerToGoogleCalendar(token);
    await loadGoogleCalendarEvents(token);
    let msg = `Google Calendar: ${pushed} Task(s) Added`;
    if (skipped) msg += `, ${skipped} Already Synced`;
    if (failed) msg += `, ${failed} Failed`;
    showToast(msg + ".");
}
