import { getTodayKey, dateKey, escapeHtml, generateId } from './utils.js';
import { getPlannerDB, savePlannerDB } from './storage.js';
// Forward reference — ui.js imports FROM this module (carryOverIncompleteTodos,
// renderSidebarTools, renderPlannerCalendar), so this is a circular import.
// Same pattern already used by notifications.js: only called inside function
// bodies at runtime, never at module top-level, so it's safe once main.js
// has wired the full module graph.
import { showToast, lockBodyScroll, unlockBodyScroll } from './ui.js';

let calViewYear, calViewMonth;
let plannerActiveDateKey = null;

// Priority is optional on older saved tasks (added before this feature) —
// anything missing/unrecognized defaults to "medium" everywhere it's read.
const PRIORITY_RANK = { high: 0, medium: 1, low: 2 };
const PRIORITY_EMOJI = { high: "🔴", medium: "🟡", low: "🟢" };
function getPriorityRank(p) { return PRIORITY_RANK[p] !== undefined ? PRIORITY_RANK[p] : PRIORITY_RANK.medium; }
function getPriorityEmoji(p) { return PRIORITY_EMOJI[p] || PRIORITY_EMOJI.medium; }

// Shared by renderSidebarTools and renderPlannerTasks: completed tasks
// always sink to the bottom regardless of sort mode (unchanged from
// before); within each done/not-done group, sort by the selected mode.
function sortTaskIndices(tasks, sortMode) {
    return tasks.map((t, i) => i).sort((a, b) => {
        if (tasks[a].done !== tasks[b].done) return tasks[a].done ? 1 : -1;
        if (sortMode === "priority-desc") return getPriorityRank(tasks[a].priority) - getPriorityRank(tasks[b].priority);
        if (sortMode === "priority-asc") return getPriorityRank(tasks[b].priority) - getPriorityRank(tasks[a].priority);
        return a - b; // "added" — original insertion order
    });
}

// Original inlined this in window.onload: `let now = new Date(); calViewYear
// = now.getFullYear(); calViewMonth = now.getMonth(); renderPlannerCalendar();`
// Exposed here so main.js (Step 7) can call it instead of reaching into this
// module's private state.
export function initPlannerCalendar() {
    let now = new Date();
    calViewYear = now.getFullYear();
    calViewMonth = now.getMonth();
    renderPlannerCalendar();
}

// ----------------- SIDEBAR TODO (today only) -----------------
export function addTodo() {
    let inp = document.getElementById("todo-input"); if (!inp.value.trim()) return;
    let text = inp.value.trim();
    let prioritySel = document.getElementById("todo-priority-select");
    let priority = prioritySel ? prioritySel.value : "medium";
    let todayKey = getTodayKey(); let db = getPlannerDB();
    if (!db[todayKey]) db[todayKey] = [];
    // Exact-character duplicate guard — case-sensitive match against every
    // task already on today's list (done or not), same rule applied in
    // addPlannerTask() below for the calendar modal's add box.
    if (db[todayKey].some(t => t.text === text)) { showToast("That Task Is Already on Today's List."); return; }
    // id/createdAt/updatedAt: needed so cloud sync can identify and merge
    // this exact task later instead of only ever overwriting the whole
    // day's list — see mergePlannerDB() in firebase-sync.js.
    let now = Date.now();
    db[todayKey].push({ id: generateId(), text, done: false, priority, createdAt: now, updatedAt: now });
    savePlannerDB(db); inp.value = ""; renderSidebarTools(); renderPlannerCalendar();
}

export function renderSidebarTools() {
    let todayKey = getTodayKey(); let db = getPlannerDB(); let tasks = db[todayKey] || [];
    let todoHtml = ""; if (tasks.length === 0) todoHtml = "<div style='color:var(--muted); font-size:12px; margin-top:8px;'>No tasks for today yet.</div>";
    let sortSelect = document.getElementById("todo-sort-select");
    let order = sortTaskIndices(tasks, sortSelect ? sortSelect.value : "priority-desc");
    // BUG FIX: the priority dot and the task text used to share one <span>,
    // so the done-state line-through (and the muted color) struck through
    // the emoji dot too — a strikethrough dash cutting across the colored
    // dot. The dot now sits in its own span that never gets line-through;
    // only the text span does.
    order.forEach(i => { let t = tasks[i]; todoHtml += `<div class="todo-item"><input type="checkbox" ${t.done?'checked':''} onchange="toggleTodo(${i})"><span class="todo-item-body"><span class="priority-dot">${getPriorityEmoji(t.priority)}</span><span class="todo-text" style="${t.done?'text-decoration:line-through;color:var(--muted);':''}">${escapeHtml(t.text)}</span></span><button class="del" onclick="deleteTodo(${i})">✕</button></div>`; });
    document.getElementById("todo-list").innerHTML = todoHtml;
    let countBadge = document.getElementById("todo-count-badge");
    if (countBadge) countBadge.textContent = tasks.filter(t => !t.done).length;
}

export function toggleTodo(idx) {
    let todayKey = getTodayKey(); let db = getPlannerDB();
    if (!db[todayKey] || !db[todayKey][idx]) return;
    db[todayKey][idx].done = !db[todayKey][idx].done;
    // Stamp the edit — this is what lets a later sync merge know THIS
    // change is newer than whatever's in the cloud (or vice versa) instead
    // of guessing. See mergePlannerDB() in firebase-sync.js.
    db[todayKey][idx].updatedAt = Date.now();
    savePlannerDB(db); renderSidebarTools(); renderPlannerCalendar();
}

export function deleteTodo(idx) {
    let todayKey = getTodayKey(); let db = getPlannerDB();
    if (!db[todayKey]) return;
    db[todayKey].splice(idx, 1); savePlannerDB(db); renderSidebarTools(); renderPlannerCalendar();
}

// Called once from checkDayRollover() (ui.js) whenever local midnight is
// detected to have flipped over. Any todo still unchecked on a past day is
// offered forward onto today's list instead of silently vanishing onto a
// date the user will likely never revisit — the 8pm planner reminder
// (notifications.js) nudges them beforehand, but this is the last chance.
// Completed tasks stay put on the day they were finished either way.
//
// BUG FIX (persistent carryover failures — "sometimes it doesn't work,
// sometimes it doesn't appear at all"): this used to gate the whole
// transfer behind a native `confirm()` dialog, called synchronously from
// inside checkDayRollover()'s async flow — often triggered by a
// visibilitychange tick firing in the background (phone screen turning on
// overnight, a laptop waking from sleep). Two things about that combination
// are unreliable on real devices: (1) browsers can silently ignore/auto-
// dismiss alert()/confirm()/prompt() calls that aren't tied to a direct tap
// or click, especially from a backgrounded or not-yet-focused tab, so the
// dialog sometimes just never appeared; (2) even when it did, the caller
// (checkDayRollover()) advanced the stored "current day" pointer right
// after this call returned NO MATTER what the user answered — so a
// declined, or silently-swallowed, dialog permanently orphaned that day's
// tasks: the pointer had already moved past them, and the next rollover
// only ever looks at the single most-recent day, never that older one.
//
// Fixed by dropping confirm() for a normal in-app modal (works exactly like
// every other dialog in this app, immune to the background-dialog-
// suppression behavior above), and — the more important half of the fix —
// no longer trusting a single "yesterday" pointer at all. Every call scans
// the WHOLE planner DB for any day before today that still has undone
// tasks sitting in it, however many days back and for whatever reason they
// never got moved (a missed dialog, a decline, the app not being opened for
// several days). That list is re-offered every single rollover until the
// user actually accepts it or clears those tasks themselves — so nothing
// ends up permanently stuck no matter what happened on any earlier attempt.
let pendingCarryOver = null;
export function carryOverIncompleteTodos(newDayKey) {
    let db = getPlannerDB();
    let staleDayKeys = Object.keys(db)
        .filter(k => /^\d{4}-\d{2}-\d{2}$/.test(k) && k < newDayKey && (db[k] || []).some(t => !t.done))
        .sort();
    if (staleDayKeys.length === 0) return;

    let incomplete = [];
    staleDayKeys.forEach(k => (db[k] || []).filter(t => !t.done).forEach(t => incomplete.push(t)));
    if (incomplete.length === 0) return;

    pendingCarryOver = { staleDayKeys, newDayKey, incomplete };
    renderCarryOverModal(incomplete);
    document.getElementById("carryover-modal").style.display = "flex";
    lockBodyScroll();
}

function renderCarryOverModal(incomplete) {
    let isSingle = incomplete.length === 1;
    document.getElementById("carryover-modal-title").textContent =
        `You have ${incomplete.length} incomplete ${isSingle ? "task" : "tasks"} from before today:`;
    document.getElementById("carryover-modal-list").innerHTML = incomplete
        .map((t, i) => `<div class="carryover-item">${i + 1}. ${getPriorityEmoji(t.priority)} ${escapeHtml(t.text)}</div>`)
        .join("");
}

// "Yes, transfer" button on the carryover modal.
export function confirmCarryOverTodos() {
    if (!pendingCarryOver) { closeCarryOverModal(); return; }
    let { staleDayKeys, newDayKey, incomplete } = pendingCarryOver;
    let db = getPlannerDB();
    // Bump updatedAt on every moved task. A task can end up listed under
    // BOTH the old and new day-key after a merge — e.g. this device carries
    // it over locally at the same moment a cloud snapshot (from before this
    // carryover, or from another device that hasn't carried it over yet)
    // still has it sitting under the old day. Both copies share the same
    // id but live under different day-keys, and a per-day-key merge alone
    // can't tell which one is "real". mergePlannerDB()'s second pass (in
    // firebase-sync.js) resolves that by id, always keeping whichever copy
    // was updated most recently and dropping the stale duplicate — which
    // only works if "moved to a new day" itself counts as an update.
    let now = Date.now();
    staleDayKeys.forEach(k => { db[k] = (db[k] || []).filter(t => t.done); });
    let moved = incomplete.map(t => ({ ...t, updatedAt: now }));
    db[newDayKey] = (db[newDayKey] || []).concat(moved);
    savePlannerDB(db);
    let count = moved.length;
    closeCarryOverModal();
    renderSidebarTools(); renderPlannerCalendar();
    showToast(`Moved ${count} ${count === 1 ? "Task" : "Tasks"} to Today.`);
}

// "Not now" button on the carryover modal — leaves the old tasks exactly
// where they are (still on their original day, still undone), so they get
// offered again on the next rollover instead of being lost.
export function declineCarryOverTodos() {
    closeCarryOverModal();
}

function closeCarryOverModal() {
    pendingCarryOver = null;
    document.getElementById("carryover-modal").style.display = "none";
    unlockBodyScroll();
}

// ----------------- CALENDAR + PER-DAY PLANNER MODAL -----------------
export function calShiftMonth(delta) {
    calViewMonth += delta;
    if (calViewMonth > 11) { calViewMonth = 0; calViewYear++; }
    if (calViewMonth < 0) { calViewMonth = 11; calViewYear--; }
    renderPlannerCalendar();
}

export function renderPlannerCalendar() {
    const monthNames = ["January","February","March","April","May","June","July","August","September","October","November","December"];
    document.getElementById("cal-month-label").innerText = `${monthNames[calViewMonth]} ${calViewYear}`;
    let dowRow = document.getElementById("cal-dow-row"); dowRow.innerHTML = ""; ["S","M","T","W","T","F","S"].forEach(d => { dowRow.innerHTML += `<div class="cal-dow">${d}</div>`; });
    let grid = document.getElementById("cal-grid"); grid.innerHTML = "";
    let firstDay = new Date(calViewYear, calViewMonth, 1).getDay(); let daysInMonth = new Date(calViewYear, calViewMonth + 1, 0).getDate();
    let today = new Date(); let todayKey = dateKey(today.getFullYear(), today.getMonth(), today.getDate()); let plannerDB = getPlannerDB();
    for (let i = 0; i < firstDay; i++) grid.innerHTML += `<div class="cal-day empty"></div>`;
    for (let d = 1; d <= daysInMonth; d++) { let key = dateKey(calViewYear, calViewMonth, d); let hasTasks = plannerDB[key] && plannerDB[key].length > 0; let isToday = key === todayKey; grid.innerHTML += `<div class="cal-day ${isToday ? 'today' : ''}" onclick="openPlannerModal('${key}')">${d}${hasTasks ? '<div class="dot"></div>' : ''}</div>`; }
}

export function openPlannerModal(key) {
    plannerActiveDateKey = key; let [y, m, d] = key.split('-'); document.getElementById("planner-modal-title").innerText = `Tasks — ${d}/${m}/${y}`;
    let input = document.getElementById("planner-task-input"); let addBtn = document.getElementById("planner-add-btn"); let isPast = key < getTodayKey();
    let prioritySel = document.getElementById("planner-priority-select");
    input.value = ""; input.disabled = isPast; addBtn.disabled = isPast; addBtn.style.opacity = isPast ? "0.4" : "1"; input.placeholder = isPast ? "Cannot add tasks for a past date" : "Add task for this day...";
    if (prioritySel) prioritySel.disabled = isPast;
    renderPlannerTasks(); document.getElementById("planner-modal").style.display = "flex";
    // BUG FIX: this modal never called lockBodyScroll() (every other modal
    // in the app does — see the carryover modal above for the same pattern)
    // so the page behind it kept scrolling while it was open. Reported as
    // "background scrolling is coming" when opening a day's Tasks list from
    // the planner calendar.
    lockBodyScroll();
}

export function closePlannerModal() {
    document.getElementById("planner-modal").style.display = "none"; renderPlannerCalendar(); renderSidebarTools();
    unlockBodyScroll();
}

export function addPlannerTask() {
    if (plannerActiveDateKey < getTodayKey()) return;
    let inp = document.getElementById("planner-task-input"); if (!inp.value.trim()) return;
    let text = inp.value.trim();
    let prioritySel = document.getElementById("planner-priority-select");
    let priority = prioritySel ? prioritySel.value : "medium";
    let db = getPlannerDB(); if (!db[plannerActiveDateKey]) db[plannerActiveDateKey] = [];
    if (db[plannerActiveDateKey].some(t => t.text === text)) { showToast("That Task Is Already on This Day's List."); return; }
    let now = Date.now();
    db[plannerActiveDateKey].push({ id: generateId(), text, done: false, priority, createdAt: now, updatedAt: now });
    savePlannerDB(db); inp.value = ""; renderPlannerTasks();
}

export function togglePlannerTask(idx) {
    let db = getPlannerDB();
    if (!db[plannerActiveDateKey] || !db[plannerActiveDateKey][idx]) return;
    db[plannerActiveDateKey][idx].done = !db[plannerActiveDateKey][idx].done;
    db[plannerActiveDateKey][idx].updatedAt = Date.now();
    savePlannerDB(db); renderPlannerTasks();
}

export function deletePlannerTask(idx) {
    let db = getPlannerDB();
    if (!db[plannerActiveDateKey]) return;
    db[plannerActiveDateKey].splice(idx, 1); savePlannerDB(db); renderPlannerTasks();
}

export function renderPlannerTasks() {
    let db = getPlannerDB(); let tasks = db[plannerActiveDateKey] || [];
    let isPast = plannerActiveDateKey < getTodayKey();
    // Past dates can never have tasks added (see openPlannerModal), so an
    // empty list there is expected, not noteworthy — showing "No tasks
    // yet." reads like an invitation to add one. Only today/future empty
    // days get that message.
    let html = ""; if (tasks.length === 0 && !isPast) html = "<div style='color:var(--muted); font-size:13px; margin-top:8px;'>No tasks yet.</div>";
    let sortSelect = document.getElementById("planner-sort-select");
    let order = sortTaskIndices(tasks, sortSelect ? sortSelect.value : "added");
    // Same fix as renderSidebarTools() above — dot isolated from the
    // line-through so the strike only crosses the task text, not the dot.
    order.forEach(i => { let t = tasks[i]; html += `<div class="task-item"><input type="checkbox" ${t.done ? 'checked' : ''} onchange="togglePlannerTask(${i})"><span class="task-text"><span class="priority-dot">${getPriorityEmoji(t.priority)}</span><span class="task-text-content ${t.done ? 'done' : ''}">${escapeHtml(t.text)}</span></span><button class="del" onclick="deletePlannerTask(${i})">✕</button></div>`; });
    document.getElementById("planner-task-list").innerHTML = html;
}

// Also used by index.html directly (calendar date input picker button).
export function openDatePicker(id) {
    let el = document.getElementById(id);
    try { if (el.showPicker) { el.showPicker(); return; } } catch (e) {}
    el.focus();
}
