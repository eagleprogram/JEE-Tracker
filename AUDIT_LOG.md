\## Batch 1 — js/utils.js, js/storage.js (Pass A)



Harness: real ES-module imports of unmodified source (md5-verified against

uploaded ZIP) against custom localStorage/sessionStorage/indexedDB stand-ins.

utils.js's `./ui.js` import stubbed (showToast only).



Tests: utils.js — 90 targeted/edge-case checks + 1440-value round-trip fuzz

(stampTime12Hour -> formatTime12Hour -> timeToMinutes), all clean.

storage.js — 92 targeted/edge-case checks + 500-run fuzz of ensureDayShape

against randomized legacy/corrupted shapes + IndexedDB scenario tests

(fresh browser, stuck-at-v3 recovery, connection-blocking deadlock), all

clean (harness correctly demonstrates each bug below).



\### Bugs found

1\. \[HIGH] storage.js: openMockDB() connections are never closed anywhere in

&#x20;  the repo (grep-confirmed). wipeLocalData()'s deleteDatabase() silently

&#x20;  no-ops via onblocked when an earlier connection is still open (the

&#x20;  ordinary case) -> Reset All Data reports success but IndexedDB data

&#x20;  (mock tests, mistakes) survives. Fix: close connections after use, or

&#x20;  close explicitly before deleteDatabase() in wipeLocalData().

2\. \[HIGH, latent] storage.js: openMockDB()'s own indexedDB.open() request

&#x20;  has no onblocked handler. Combined with bug #1, any future

&#x20;  MOCK\_DB\_VERSION bump while an old connection is alive hangs every

&#x20;  mock-test/mistakes operation forever, silently. Fix: add onblocked

&#x20;  handler + fix #1.

3\. \[HIGH] storage.js: getDB() has no try/catch around JSON.parse (every

&#x20;  sibling getter does). Corrupted "jee\_ypt\_v3\_data" throws uncaught,

&#x20;  breaking the whole app. Fix: wrap in try/catch.

4\. \[MED-HIGH] storage.js: getNotifSettings() same missing try/catch on

&#x20;  "jee\_notif\_settings". Fix: wrap in try/catch.

5\. \[LOW-MED] storage.js: ensureDayShape() resets a truthy-but-non-boolean

&#x20;  questionsAsked (e.g. 1) to false instead of coercing to true — could

&#x20;  re-trigger the daily questions popup on corrupted/imported data. Fix:

&#x20;  `day.questionsAsked = !!day.questionsAsked` when not already boolean.

6\. \[VERY LOW] storage.js: ensurePlannerTaskShape()'s `!t.updatedAt` falsy

&#x20;  check mistreats updatedAt===0 as missing. Fix: typeof check instead of

&#x20;  truthiness. Low priority, no realistic trigger.

7\. \[MED, cross-cutting] utils.js/storage.js: BASE\_EXAM\_DATES hardcoded with

&#x20;  "+05:30" offset; local Date-getter reads of it (shiftDateByYears, any

&#x20;  future countdown code) give the wrong calendar day for non-IST users.

&#x20;  Confirmed via direct test. Not fixed in this batch — flag for ui.js

&#x20;  audit (Batch 9) which owns the exam countdown display.

8\. \[LOW/info] utils.js: formatTime12Hour() rejects lowercase am/pm and

&#x20;  doesn't range-validate bare "H:MM" input. No internal producer emits

&#x20;  either invalid form today; noted for if an import path is found later.

9\. \[LOW/info] utils.js: escapeHtml() throws on non-string input (no

&#x20;  defensive String() coercion). Flag for ui.js audit to check call sites.



\### Also flagged (not bugs)

No dead code, no leaked listeners, no innerHTML/XSS, no a11y issues in

either file. No unhandled-promise-rejection risk originates in these files

(sync throws inside `new Promise(executor)` auto-reject correctly) —

whether callers .catch() them is for later batches (mocktest.js,

mistakes.js, backup.js, firebase-sync.js).


## Batch 1 — js/storage.js (Pass B)



Fixed bugs #1–6 from Pass A. utils.js needed no changes (its findings were

info-only, correctly left for later/never).



1+2. openMockDB(): added onblocked rejection; getAllMockTests/getMistakeEntry/

&#x20;    saveMistakeEntry/getAllMistakeChapters now close their connection in a

&#x20;    finally block. NOT fixed: mocktest.js/backup.js/firebase-sync.js's own

&#x20;    direct openMockDB() calls still leak — flagged for Batch 5-7.

3\. getDB(): added try/catch, falls back to {}.

4\. getNotifSettings(): added try/catch, falls back to defaults.

5\. ensureDayShape(): questionsAsked now coerced (!!) instead of hard-reset.

6\. ensurePlannerTaskShape(): updatedAt uses typeof check instead of falsy check.



Harness re-ran clean: utils.js 90/90, storage.js 96/96 (incl. 500-run fuzz),

5x repeat with no flakiness. Only js/storage.js changed.

