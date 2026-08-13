# Background Alerts (Push API) Setup — free, one-time

This adds a **second delivery channel** for reminders/alarms, on top of the
existing in-tab one:

- **In-tab (already existed):** works while the browser process is alive
  somewhere — tab minimized, another app in front, phone screen off briefly.
  Nothing to set up; it's the "🔔 Notifications" section already in Settings.
- **Background push (new, this doc):** ALSO reaches the device when the
  browser is fully closed. Requires the one-time setup below, and a tiny
  free scheduled job that decides when to send.

Total cost: **$0**, as long as you stay within the free tiers described
below (for one person's personal study tracker, you will — by a wide
margin). No credit card is required anywhere in this setup.

---

## How it works (so the moving parts make sense)

1. Your browser gets a unique **push token** from Google's FCM service and
   saves it to your Firestore user doc (`js/push-notifications.js`).
2. A small Node script (`server/send-scheduled-alarms.js`) reads everyone's
   notification settings + relevant data from Firestore, figures out what's
   due right now, and sends it as a push message to the right token(s).
3. That script is run **every 5 minutes, for free, by GitHub Actions**
   (`.github/workflows/scheduled-alarms.yml`) — GitHub's own cron scheduler,
   not a paid server you have to run yourself.
4. Your device's service worker (`sw.js`) receives the push and shows the
   same alarm notification (sound/vibrate/"Stop Alarm" button) it already
   shows for in-tab reminders — even if no tab is open at all.

---

## One-time setup (about 10 minutes)

### 1. Generate a Web Push (VAPID) key — free

1. Go to the [Firebase Console](https://console.firebase.google.com/) → your
   project (`jee-study-tracker-99`).
2. Click the gear icon → **Project settings** → **Cloud Messaging** tab.
3. Under **Web configuration** → **Web Push certificates**, click
   **Generate key pair**.
4. Copy the long key string it shows you.
5. Open `js/push-notifications.js` and replace:
   ```js
   const VAPID_PUBLIC_KEY = "PASTE_YOUR_VAPID_PUBLIC_KEY_HERE";
   ```
   with your copied key (keep the quotes).

### 2. Generate a service account key — free

This is what lets the scheduled script (running on GitHub's servers, not
your browser) read/write your Firestore data.

1. Firebase Console → gear icon → **Project settings** → **Service accounts**
   tab.
2. Click **Generate new private key** → confirm. A `.json` file downloads.
3. **Do not commit this file to the repo — it's a secret.** You'll paste its
   contents into a GitHub secret in the next step instead.

### 3. Add the GitHub secret

1. On GitHub, go to your repo → **Settings** → **Secrets and variables** →
   **Actions** → **New repository secret**.
2. Name: `FIREBASE_SERVICE_ACCOUNT_JSON`
3. Value: open the `.json` file you downloaded in a text editor, select all,
   copy, and paste the **entire contents** as the secret value.
4. Save.

### 4. Update Firestore security rules

Your existing rules already let a signed-in user read/write their own
`users/{uid}` document (that's how cloud sync already works) — the new
`fcmTokens` and `serverNotifFlags` fields ride on that same document, so
**no rule change is usually needed**. If your rules restrict which *fields*
can be written (uncommon, but check Firebase Console → Firestore Database →
Rules if you're unsure), make sure they allow the owner to write these two
extra fields, e.g.:

```
match /users/{userId} {
  allow read, write: if request.auth != null && request.auth.uid == userId;
}
```

The service account used by the scheduled script bypasses security rules
entirely (that's what "admin" access means), so rules only matter for what
your browser is allowed to write — token registration.

### 5. Deploy and test

1. Commit and push the files (see the commands your normal deploy flow
   already uses).
2. Open the deployed site, sign in, go to Settings → 🔔 Notifications →
   scroll to **📴 Background Alerts** → tap **Enable** → allow the browser's
   notification permission prompt.
3. `push-permission-status` should now say "✅ Background alerts enabled on
   this device."
4. To test the scheduled job without waiting: GitHub repo → **Actions** tab
   → **JEE Tracker Scheduled Alarms** → **Run workflow** → check the run's
   log for `X push message(s) sent`.
5. Fully close the browser (not just minimize) and wait for a reminder time
   you have configured — the notification should arrive on the lock
   screen/notification tray.

---

## Limits (read this so nothing here surprises you)

- **Not instant.** The schedule runs every 5 minutes; combined with GitHub's
  own scheduling slack (see below), an alert can arrive a few minutes after
  its exact configured time. That matches what you asked for ("if it rings
  one minute later the scheduled time — it's okay").
- **GitHub does not guarantee exact cron timing.** During platform-wide high
  load, scheduled runs can be delayed by several minutes. This is a GitHub
  platform limitation, not something in this code that can be tuned away.
- **60-day auto-disable.** GitHub automatically disables scheduled workflows
  on a repo that's had **no commits at all** for 60 days. Any commit, or a
  manual "Run workflow" click, resets that clock. If background alerts
  quietly stop after a long gap of not touching the repo, check the Actions
  tab and re-enable the workflow there.
- **Break-overrun and idle-nudge stay tab-only.** Both depend on knowing
  *right now* whether a study session is actively running — that live state
  isn't synced to the cloud in real time, so the scheduled script has
  nothing to check. Every other reminder type (revision, parent log, sleep,
  planner tasks, exam milestones, backup) is covered.
- **Free tier headroom (for context, not something you need to actively
  manage at this scale):** GitHub Actions gives public repos unlimited
  minutes and private repos 2,000 free minutes/month — this job takes well
  under a minute per run. Firebase Cloud Messaging sending is free with no
  quota in the way that matters here. Firestore's free tier is 50,000 reads
  and 20,000 writes per day — a run every 5 minutes for one user is a
  handful of reads/writes per run, nowhere close to that ceiling.
- **This is still not a literal 100%-guaranteed pager.** Nothing free and
  backend-optional can promise that (a phone with the OS itself dead/off, no
  network at all, etc. is beyond any web app's reach). This setup closes the
  one gap pure client-side code genuinely can't: the browser fully closed.
