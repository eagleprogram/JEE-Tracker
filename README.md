# JEE 2027 Study Tracker & Planner — v2.0

JEE Study Tracker v2.0 is a complete, modular overhaul of a personal productivity tool designed specifically for JEE 2027 aspirants. Unlike generic study apps, this tracker combines a precision-engineered study timer, a comprehensive syllabus tracker, and a visual reward system (garden & heatmap) into an offline-first, installable Progressive Web App (PWA). 

Rebuilt from the ground up using modern ES module architecture, this version eliminates previous bottlenecks and bug traps, such as the XSS vulnerability in the task planner and the phantom features that never triggered. The core remains an accurate, `performance.now()`-based timer capable of handling midnight rollovers and crash recovery. The day-to-day experience is enhanced by a seamless planner calendar, a 9-tag syllabus progress monitor across Physics, Chemistry, and Mathematics, and a mock test dashboard that supports mistake tagging and file attachments. The app automatically generates stunning A4 weekly and monthly reports and can send them via email through a secure Cloudflare Worker proxy. 

For multi-device users, Firebase Firestore provides effortless, cross-device synchronization of study logs, planner tasks, sleep data, and syllabus progress. Everything is designed to work offline-first, ensuring students can maintain their focus without worrying about network connectivity. This v2.0 isn't just a feature update; it's a refactoring milestone, structured into 26 logical files, making it significantly more maintainable, performant, and resilient for the years of preparation ahead. It's more than a tracker—it's a complete daily study companion built with a developer's precision and a student's needs in mind.

## Key Features

- **Precision Timer Engine:** Powered by `performance.now()`, handles midnight rollovers, session recovery, and auto-saves every 20 seconds.
- **Comprehensive Planner:** Includes a daily to-do list, interactive calendar, and task management.
- **Syllabus Tracker:** 9 custom tags per chapter across Physics, Chemistry, and Mathematics with visual progress bars.
- **Advanced Analytics:** Visualize your habits with a 12-month study heatmap, weekly subject trend charts, and an interactive tree garden that rewards 10-hour streaks.
- **Automated A4 Reports:** Generates professional, stylized weekly and monthly PNG reports with automatic email delivery via Cloudflare Worker.
- **Mock Test & Analysis:** IndexedDB-backed storage for scores, mistake tags (e.g., "Concept gap", "Calculation error"), and file attachments (images/PDFs).
- **Offline-First PWA:** Service worker caching enables full functionality without an internet connection.
- **Cross-Device Cloud Sync:** Securely syncs all data (study logs, planner, sleep, syllabus) across devices using Firebase Auth and Firestore.

---

## Tech Stack

- **Frontend:** HTML5 / CSS3 / Vanilla JavaScript (ES Modules)
- **Authentication & Sync:** Firebase Auth (Google Sign-In) + Firestore
- **Attachments:** IndexedDB (mock test files and images)
- **Email Automation:** Cloudflare Worker + Brevo (Sendinblue)
- **Hosting & PWA:** GitHub Pages (100% static, installable)

---

## Folder Structure

```text
Tracker/
├── index.html          — page shell, all markup
├── manifest.json       — PWA manifest
├── sw.js               — service worker (offline app-shell caching)
├── icons/              — PWA icons (192px, 512px)
├── css/
│   ├── variables.css   — color/spacing tokens only
│   ├── base.css        — layout, sidebar, scrollbars
│   ├── components.css  — cards, buttons, modals, inputs, badges
│   └── charts.css      — garden, heatmap, pie, trend chart styling
└── js/
    ├── utils.js        — pure helper functions, no DOM/storage
    ├── storage.js      — the only file that touches localStorage/IndexedDB
    ├── timer.js        — study/break timer state machine
    ├── notifications.js — idle nudge, break overrun, reminders, pings
    ├── planner.js      — to-do list + calendar
    ├── history.js      — logs, per-entry delete
    ├── sleep.js        — sleep/wake log
    ├── syllabus.js     — chapter-by-chapter syllabus tracker
    ├── mocktest.js     — mock test scores + mistake tags
    ├── youtube.js      — study-music player + history
    ├── charts.js       — garden, heatmap, streak, trend
    ├── reports.js      — share/download/email reports
    ├── backup.js       — export/import JSON
    ├── firebase-sync.js — auth + cloud sync
    ├── ui.js           — sidebar, toasts, countdown
    └── main.js         — entry point, wires it all
```

## Known Bugs Fixed in This Rebuild

During the v2.0 code audit, the following critical and phantom bugs were confirmed and permanently resolved:

- ✅ **Planner XSS** – Task text is now strictly escaped using `escapeHtml()`.
- ✅ **Missing `renderSyncUI` / `deleteCloudData`** – Sync UI and cloud data deletion now function correctly.
- ✅ **Subject-Modal Back Button** – Cancelling subject selection no longer freezes the timer.
- ✅ **Idle Nudge, Exam Milestone pings, and Backup Reminder** – All three features now have fully implemented, working logic (previously only the UI existed).
- ✅ **Heatmap 0-hour cells** – Colors are now clearly visible against the dark card background.


## Resources Used

- **GitHub Pages** — Hosting (repo: `eagleprogram/Tracker`)
- **Firebase** — Auth + Firestore (free Spark plan)
- **Cloudflare Worker** — Email-sending proxy (keeps the Brevo API key server-side)
- **Brevo (Sendinblue)** — Transactional email provider
