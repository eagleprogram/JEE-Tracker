import { escapeHtml } from './utils.js';
import { getYtHistory, saveYtHistory, getRawFlag, setRawFlag, clearRawFlag, YT_HISTORY_MAX_ENTRIES } from './storage.js';
// Forward reference — ui.js lands in Step 7. Only called inside function
// bodies, safe once the full module graph is wired in main.js.
import { showToast } from './ui.js';

let ytPlayer = null, ytApiReady = false, ytLoopEnabled = false, ytPendingVideoId = null;
let ytIsPlaying = false;
// Tracks whichever video is currently loaded in the player, purely so
// fetchYtTitle()'s async oEmbed response (see below) can tell whether the
// title it just resolved still belongs to what's on screen before using it
// to update the "Now Playing" label.
let ytCurrentId = null;
// Feature request: YouTube Shorts should never remember/resume a playback
// position — always start from 0 whenever loaded, regardless of where the
// user left off last time. Determined purely from the URL ("/shorts/" —
// see isShortsUrl() below) at load time in loadYoutubeLink(), the single
// choke point both a fresh paste AND loadFromYtHistory() route through
// (history entries store their original URL and always re-submit it there).
let ytCurrentIsShort = false;
function isShortsUrl(url) { return /\/shorts\//.test(url || ""); }
// Feature request: 0 for a Short (never resume it), otherwise whatever was
// actually saved for this video — single choke point for every "where
// should this video start from" read below.
function resumePositionFor(id) { return ytCurrentIsShort ? 0 : getYtPosition(id); }
// Volume sync: our slider pushes to the player on every drag (ytSetVolume,
// wired inline below), but the native control bar's own volume slider is
// inside the iframe — cross-origin, so we can't listen to it directly. This
// interval polls getVolume() instead, which reflects the player's actual
// level no matter which UI changed it, and mirrors it back onto our
// slider. ytVolumeDragging guards against the poll fighting an in-progress
// drag on our own slider.
let ytVolumeSyncInterval = null;
let ytVolumeDragging = false;
// Throttle counter for the position autosave inside startYtVolumeSync()'s
// existing 1s poll — see saveYtPosition() above.
let ytPositionSaveTick = 0;
// Cycled by ytCycleSpeed() below — 1x sits in the middle so the common
// "slightly faster" bump (1.25x/1.5x) is one tap away either direction from
// the default, same spirit as the Loop toggle being one tap.
const YT_SPEED_STEPS = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];
let ytPlaybackRate = 1;

// Feature request: remember playback position per video (keyed by video
// id, not URL — the same video reloaded from a different pasted link still
// resumes) so refreshing the tab or leaving and coming back via History
// picks up where it left off, instead of always restarting from 0:00.
// Saved periodically while playing (see startYtVolumeSync()'s poll below,
// which already runs once a second) and flushed immediately on pause/close/
// tab-hide so a refresh right after doesn't lose more than ~1s of progress.
function ytPositionKey(id) { return `jee_yt_position_${id}`; }
function saveYtPosition(id, seconds) {
    if (!id || !(seconds > 0)) return;
    setRawFlag(ytPositionKey(id), String(Math.floor(seconds)));
}
function getYtPosition(id) {
    let raw = getRawFlag(ytPositionKey(id));
    let n = raw ? parseInt(raw, 10) : 0;
    return isNaN(n) ? 0 : n;
}
function clearYtPosition(id) { clearRawFlag(ytPositionKey(id)); }

// Small inline icons (feather-icons-style, currentColor stroke/fill) for
// the control buttons below — replaces the old emoji (▶/⏸/⏩/🔁), which
// rendered at inconsistent sizes/baselines across platforms. Sized and
// aligned via .yt-ctrl-icon in components.css.
const YT_ICON_PLAY = `<svg viewBox="0 0 24 24" fill="currentColor" class="yt-ctrl-icon"><path d="M8 5v14l11-7z"/></svg>`;
const YT_ICON_PAUSE = `<svg viewBox="0 0 24 24" fill="currentColor" class="yt-ctrl-icon"><rect x="6" y="5" width="4" height="14" rx="1"/><rect x="14" y="5" width="4" height="14" rx="1"/></svg>`;
const YT_ICON_SPEED = `<svg viewBox="0 0 24 24" fill="currentColor" class="yt-ctrl-icon"><path d="M2 5v14l8-7z"/><path d="M12 5v14l8-7z"/></svg>`;
const YT_ICON_LOOP = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" class="yt-ctrl-icon"><path d="M17 1l4 4-4 4"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><path d="M7 23l-4-4 4-4"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/></svg>`;

// Feature request: flush the current position the instant the tab is
// hidden (backgrounded, switching apps, or about to be closed/refreshed) —
// the periodic autosave in startYtVolumeSync() below only runs every ~5s,
// so this catches the gap right up to the moment of a refresh that a purely
// periodic save could miss. Registered once at module load — youtube.js
// itself is only ever imported/evaluated once.
document.addEventListener("visibilitychange", () => {
    if (!ytCurrentIsShort && document.hidden && ytPlayer && ytCurrentId && ytPlayer.getCurrentTime) {
        try { saveYtPosition(ytCurrentId, ytPlayer.getCurrentTime()); } catch (e) { /* player mid-teardown — nothing to save */ }
    }
});

// Updates both the icon and label for the Play/Pause button — used by
// onStateChange (real play/pause events) and ytClosePlayer() (resetting
// back to the "Play" state when the player is torn down).
function setPlayPauseUI(isPlaying) {
    let icon = document.getElementById("yt-playpause-icon");
    let label = document.getElementById("yt-playpause-label");
    if (icon) icon.innerHTML = isPlaying ? YT_ICON_PAUSE : YT_ICON_PLAY;
    if (label) label.textContent = isPlaying ? "Pause" : "Play";
}

export function extractYouTubeId(url) {
    try {
        let u = new URL(url);
        if (u.hostname.includes("youtu.be")) return u.pathname.slice(1);
        if (u.searchParams.get("v")) return u.searchParams.get("v");
        let m = u.pathname.match(/\/embed\/([^/?]+)/);
        if (m) return m[1];
        let sm = u.pathname.match(/\/shorts\/([^/?]+)/);
        if (sm) return sm[1];
    } catch (e) {}
    return null;
}

export function loadYTApiScript() {
    if (document.getElementById("yt-iframe-api")) return;
    let tag = document.createElement("script");
    tag.id = "yt-iframe-api";
    tag.src = "https://www.youtube.com/iframe_api";
    document.body.appendChild(tag);
}

// The YouTube IFrame API calls this by name on window once it's loaded —
// it must stay a window-level assignment (matches the original exactly).
window.onYouTubeIframeAPIReady = function() {
    ytApiReady = true;
    if (ytPendingVideoId) {
        createOrLoadYTPlayer(ytPendingVideoId);
        ytPendingVideoId = null;
    }
};

export function createOrLoadYTPlayer(id) {
    // BUG FIX: resume-position (and pause/end position-saving) previously
    // only worked for whichever video the player was ORIGINALLY constructed
    // with — the onReady/onStateChange callbacks below are bound once, at
    // construction, so a closure over the `id` parameter stays stuck on
    // that first video forever. Every subsequent video switch went through
    // loadVideoById() instead (the branch just below) reusing those SAME
    // stale callbacks — so a pause on video B was silently saving position
    // under video A's key, and video A never got its own onReady to resume
    // from in the first place. Fixed by reading the shared, always-current
    // ytCurrentId module variable inside the callbacks instead of the
    // captured `id` parameter — ytCurrentId is updated by loadYoutubeLink()
    // before this function is ever called, fresh construction or reuse
    // alike, so the callbacks always know which video is ACTUALLY loaded
    // right now.
    if (ytPlayer && ytPlayer.loadVideoById) {
        // BUG FIX: loading a second video into an already-open player used
        // to leave the PREVIOUS video's speed sitting in ytPlaybackRate and
        // on the Speed button — YouTube itself resets a freshly loaded
        // video to 1x, but our own state/label never followed, so the old
        // rate (e.g. 1.75x) looked like it was carrying over. Reset both
        // right here, before the new video even starts.
        ytPlaybackRate = 1;
        let speedBtn = document.getElementById("yt-speed-label");
        if (speedBtn) speedBtn.innerText = "Speed: 1x";
        // BUG FIX: loadVideoById() does NOT fire onReady (that only fires
        // once, at player construction) — so the resume-position seekTo()
        // that used to live only in onReady below never ran for any video
        // loaded after the very first one. loadVideoById's own second
        // argument (startSeconds) is the actual fix: it resumes exactly
        // where a previous session (or the last time this same video was
        // loaded) left off, the same way the `start` playerVar does for a
        // brand new player below.
        ytPlayer.loadVideoById(id, resumePositionFor(id));
        if (ytPlayer.setPlaybackRate) ytPlayer.setPlaybackRate(1);
        return;
    }
    let container = document.getElementById('yt-player');
    if (!container) return;
    bindVolumeSliderDragTracking();
    ytPlayer = new YT.Player('yt-player', {
        height: '100%', width: '100%', videoId: id,
        host: 'https://www.youtube-nocookie.com',
        // `start`: feature request — resume from wherever this exact video
        // was last left off (refresh, tab close, or re-loading it from
        // History), for the initial player-construction case. The
        // loadVideoById(id, startSeconds) call above covers every load
        // after this first one. Always 0 for a Short — see
        // resumePositionFor()/ytCurrentIsShort above.
        playerVars: { rel: 0, origin: window.location.origin, start: Math.floor(resumePositionFor(id)) },
        events: {
            onReady: (e) => {
                e.target.setVolume(parseInt(document.getElementById("yt-volume").value));
                // Re-apply whatever speed was already selected — matters when
                // loadYoutubeLink() swaps in a new video without the player
                // having been closed first (createOrLoadYTPlayer's
                // loadVideoById branch resets YouTube's own rate to 1x, but
                // our button/state should stay consistent with what's shown).
                if (ytPlaybackRate !== 1) e.target.setPlaybackRate(ytPlaybackRate);
                // Safety-net re-seek in case the `start` playerVar above
                // wasn't honored exactly (a known occasional quirk) —
                // harmless no-op if it already landed in the right place.
                let savedPos = resumePositionFor(id);
                if (savedPos > 3) e.target.seekTo(savedPos, true);
                startYtVolumeSync();
            },
            onStateChange: (e) => {
                ytIsPlaying = (e.data === YT.PlayerState.PLAYING);
                setPlayPauseUI(ytIsPlaying);
                // Flush the position immediately on every pause (in addition
                // to the periodic save while playing — see
                // startYtVolumeSync()'s poll) so pausing right before closing
                // the tab doesn't lose anything. ytCurrentId, not the
                // closed-over `id` — see this function's opening comment.
                // Feature request: never for a Short — see ytCurrentIsShort.
                if (!ytCurrentIsShort && e.data === YT.PlayerState.PAUSED && ytPlayer.getCurrentTime) {
                    saveYtPosition(ytCurrentId, ytPlayer.getCurrentTime());
                }
                // On end: always clear the saved resume position for this
                // video first — a completed watch shouldn't leave a "resume
                // near the very end" position sitting around for the NEXT
                // time this exact video gets loaded (switch away and back,
                // or reopen later), so it restarts from 0 then.
                //
                // Whether it replays RIGHT NOW (in this same session) is
                // gated behind the Loop button (ytLoopEnabled) — that's the
                // button's actual job. A previous fix made every video loop
                // unconditionally, which silently ignored the Loop toggle
                // entirely; that's reverted here. With Loop off (the
                // default), the video just stops at the end, same as
                // YouTube's own default behavior.
                if (e.data === YT.PlayerState.ENDED) {
                    clearYtPosition(ytCurrentId);
                    if (ytLoopEnabled) {
                        ytPlayer.seekTo(0);
                        ytPlayer.playVideo();
                    }
                }
            },
            onError: (e) => {
                let reasons = { 2: "Invalid video link.", 5: "Can't play in embedded player.", 100: "Video not found.", 101: "Embedding disabled.", 150: "Embedding disabled." };
                showToast(`Couldn't play — ${reasons[e.data] || "error " + e.data}`);
            }
        }
    });
}

export function loadYoutubeLink() {
    let url = document.getElementById("yt-link-input").value.trim();
    let id = extractYouTubeId(url);
    if (!id) { alert("Invalid YouTube link."); return; }
    // Flush the outgoing video's position before switching away from it —
    // otherwise pasting a new link mid-playback would lose whatever wasn't
    // already caught by the periodic save (see startYtVolumeSync()'s poll).
    // Uses the OUTGOING video's Shorts status (ytCurrentIsShort hasn't been
    // updated to the new video yet at this point) — correct either way,
    // since a Short's position was never being saved in the first place.
    if (!ytCurrentIsShort && ytPlayer && ytCurrentId && ytPlayer.getCurrentTime) {
        saveYtPosition(ytCurrentId, ytPlayer.getCurrentTime());
    }
    setRawFlag("jee_yt_last_link", url);
    addToYtHistory(id, url);
    document.getElementById("yt-player-wrap").style.display = "block";
    // Swap the raw link out for a "Now Playing: <title>" label once a video
    // is actually loaded, instead of leaving the pasted URL sitting in the
    // input above the Load/History buttons. The title itself may not be
    // known yet (addToYtHistory()'s fetchYtTitle() call resolves it
    // async) — show the video id as a placeholder and setNowPlayingLabel()
    // upgrades it to the real title the moment that request comes back.
    ytCurrentId = id;
    ytCurrentIsShort = isShortsUrl(url);
    let existing = getYtHistory().find(v => v.id === id);
    setNowPlayingLabel(id, existing ? existing.title : null);
    if (!ytApiReady) { ytPendingVideoId = id; loadYTApiScript(); return; }
    createOrLoadYTPlayer(id);
}

// Shows "▶ Now Playing: <title>" in place of the link input once a video is
// loaded (falls back to the bare video id until the real title resolves),
// and hides the input so the raw YouTube link isn't what's on screen. The
// input reappears (see ytClosePlayer()) once the player is closed, ready
// for the next link to be pasted in.
function setNowPlayingLabel(id, title) {
    let label = document.getElementById("yt-now-playing");
    let input = document.getElementById("yt-link-input");
    if (!label || !input) return;
    ytEditingNowPlaying = false;
    label.textContent = `▶ Now Playing: ${title || id}`;
    label.style.display = "block";
    input.style.display = "none";
}

// Feature request: clicking the (now dimmer, see .yt-now-playing in
// components.css) "Now Playing" label swaps it back for the paste-a-link
// input, without closing/destroying the current player — the video keeps
// playing behind it until a new link is actually submitted via Load.
// BUG FIX: this click was reaching the document-level "click outside
// closes it" listener below via normal event bubbling, on the SAME click
// that opened it — since the label itself isn't the input or the Load
// button, that listener was undoing this function's own work a split
// second after it ran (label shown → input hidden again, immediately).
// stopPropagation() here stops that same click from ever reaching the
// document listener in the first place.
let ytEditingNowPlaying = false;
export function ytEditNowPlaying(e) {
    if (e) e.stopPropagation();
    let label = document.getElementById("yt-now-playing");
    let input = document.getElementById("yt-link-input");
    if (!label || !input) return;
    ytEditingNowPlaying = true;
    label.style.display = "none";
    input.style.display = "";
    input.value = "";
    input.focus();
}

// Feature request: if the user opens the paste-a-link input (via
// ytEditNowPlaying() above) and then clicks anywhere ELSE — the sidebar,
// History, anything — without actually submitting a new link, revert back
// to showing the Now Playing label instead of leaving an empty input
// sitting there. loadYoutubeLink() itself already clears ytEditingNowPlaying
// once a link IS submitted (via setNowPlayingLabel()), so this only fires
// for the "changed their mind" case. Registered once at module load, same
// pattern as the visibilitychange listener above.
document.addEventListener("click", (e) => {
    if (!ytEditingNowPlaying) return;
    let input = document.getElementById("yt-link-input");
    let loadBtn = document.getElementById("yt-load-btn");
    if (!input) return;
    if (input.contains(e.target) || (loadBtn && loadBtn.contains(e.target))) return;
    // Nothing to revert TO if no video has ever actually been loaded yet —
    // leave the input as-is in that case.
    if (!ytCurrentId) return;
    ytEditingNowPlaying = false;
    input.style.display = "none";
    let label = document.getElementById("yt-now-playing");
    if (label) label.style.display = "block";
});

// Moved here from storage.js — storage.js now only exposes plain
// getYtHistory/saveYtHistory, and this module (the only caller) owns the
// re-render + title-fetch behavior that goes with adding/removing an entry.
export function addToYtHistory(id, url) {
    let existing = getYtHistory().find(v => v.id === id);
    let hist = getYtHistory().filter(v => v.id !== id);
    // Carry the starred flag (and known title) forward when a video already
    // in history gets reloaded — re-loading a bookmarked video shouldn't
    // silently un-star it.
    hist.unshift({ id, url, title: existing ? existing.title : null, addedAt: Date.now(), starred: existing ? !!existing.starred : false });
    if (hist.length > YT_HISTORY_MAX_ENTRIES) hist = hist.slice(0, YT_HISTORY_MAX_ENTRIES);
    saveYtHistory(hist);
    renderYtHistory();
    fetchYtTitle(id);
}

// Starred videos are pinned to the top of the history list (bookmark),
// keeping insertion order within each group (starred-first, then the rest
// newest-first as before).
export function toggleYtHistoryStar(id) {
    let hist = getYtHistory();
    let entry = hist.find(v => v.id === id);
    if (!entry) return;
    entry.starred = !entry.starred;
    saveYtHistory(hist);
    renderYtHistory();
}

export function deleteYtHistoryEntry(id) {
    if (!confirm("Remove this video from history?")) return;
    let hist = getYtHistory().filter(v => v.id !== id);
    saveYtHistory(hist);
    renderYtHistory();
}

export function fetchYtTitle(id) {
    fetch(`https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${id}&format=json`)
        .then(r => r.ok ? r.json() : null)
        .then(data => {
            if (!data || !data.title) return;
            let hist = getYtHistory();
            let entry = hist.find(v => v.id === id);
            if (entry) { entry.title = data.title; saveYtHistory(hist); renderYtHistory(); }
            // The video that's actually loaded right now might not be the one
            // this particular fetch was for (e.g. the user Loaded a second
            // link before the first one's oEmbed request came back) — only
            // upgrade the "Now Playing" label if it's still showing this id.
            if (id === ytCurrentId) setNowPlayingLabel(id, data.title);
        })
        .catch(() => {});
}

export function renderYtHistory() {
    let panel = document.getElementById("yt-history-panel");
    let hist = getYtHistory();
    if (hist.length === 0) { panel.innerHTML = `<div class="yt-history-empty">No videos loaded yet.</div>`; return; }
    // Starred (bookmarked) videos float to the top; within each group,
    // original order (newest-loaded-first) is preserved.
    let ordered = hist.slice().sort((a, b) => (b.starred ? 1 : 0) - (a.starred ? 1 : 0));
    panel.innerHTML = ordered.map(v =>
        `<div class="yt-history-item" onclick="loadFromYtHistory('${v.id}')">
            <img src="https://img.youtube.com/vi/${v.id}/mqdefault.jpg" alt="" loading="lazy">
            <span class="yt-history-label">${escapeHtml(v.title || v.id)}</span>
            <button class="yt-star-btn ${v.starred ? 'starred' : ''}" onclick="event.stopPropagation(); toggleYtHistoryStar('${v.id}')" title="${v.starred ? 'Unbookmark' : 'Bookmark'}">${v.starred ? '★' : '☆'}</button>
            <button class="del" onclick="event.stopPropagation(); deleteYtHistoryEntry('${v.id}')" style="background:none; border:none; color:#ef4444; cursor:pointer; font-size:14px; padding:0; flex-shrink:0;">✕</button>
        </div>`
    ).join("");
}

export function toggleYtHistory() {
    let panel = document.getElementById("yt-history-panel");
    let opening = !panel.classList.contains("open");
    if (opening) renderYtHistory();
    panel.classList.toggle("open", opening);
}

export function loadFromYtHistory(id) {
    let hist = getYtHistory();
    let entry = hist.find(v => v.id === id);
    let url = entry ? entry.url : `https://www.youtube.com/watch?v=${id}`;
    document.getElementById("yt-link-input").value = url;
    loadYoutubeLink();
    document.getElementById("yt-history-panel").classList.remove("open");
}

export function ytTogglePlay() {
    if (!ytPlayer) return;
    if (ytIsPlaying) { ytPlayer.pauseVideo(); } else { ytPlayer.playVideo(); }
}

export function ytSetVolume(v) {
    if (ytPlayer && ytPlayer.setVolume) ytPlayer.setVolume(v);
    // Feature request: "clicking the blue ball" (the slider thumb) should
    // preview the sound %. oninput fires on both a click and a drag, so
    // this covers either — bindVolumeSliderDragTracking() below hides it
    // again a moment after the interaction ends.
    let preview = document.getElementById("yt-volume-preview");
    if (preview) { preview.textContent = `${v}%`; preview.classList.add("visible"); }
}

// Marks our slider as "being dragged" so the poll below doesn't yank the
// handle mid-gesture. Bound once per slider element (dataset flag guards
// against re-binding on every load) since createOrLoadYTPlayer() runs on
// every video load, not just the first.
function bindVolumeSliderDragTracking() {
    let slider = document.getElementById("yt-volume");
    if (!slider || slider.dataset.dragTrackingBound) return;
    slider.dataset.dragTrackingBound = "1";
    let preview = document.getElementById("yt-volume-preview");
    slider.addEventListener("pointerdown", () => {
        ytVolumeDragging = true;
        if (preview) { preview.textContent = `${slider.value}%`; preview.classList.add("visible"); }
    });
    let release = () => {
        ytVolumeDragging = false;
        if (preview) setTimeout(() => preview.classList.remove("visible"), 500);
    };
    slider.addEventListener("pointerup", release);
    slider.addEventListener("pointercancel", release);
}
function startYtVolumeSync() {
    stopYtVolumeSync();
    ytPositionSaveTick = 0;
    ytVolumeSyncInterval = setInterval(() => {
        if (ytPlayer && ytPlayer.getVolume && !ytVolumeDragging) {
            let slider = document.getElementById("yt-volume");
            if (slider && document.activeElement !== slider) {
                let live = Math.round(ytPlayer.getVolume());
                if (String(live) !== slider.value) slider.value = live;
            }
        }
        // Position autosave (feature request) — every 5th tick of this
        // already-running 1s poll (~5s), only while actually playing.
        // Paused/ended flushes happen immediately elsewhere (onStateChange,
        // loadYoutubeLink(), ytClosePlayer(), the visibilitychange listener
        // above) — this just covers steady, uninterrupted playback.
        ytPositionSaveTick++;
        if (!ytCurrentIsShort && ytIsPlaying && ytPositionSaveTick % 5 === 0 && ytPlayer && ytCurrentId && ytPlayer.getCurrentTime) {
            saveYtPosition(ytCurrentId, ytPlayer.getCurrentTime());
        }
    }, 1000);
}
function stopYtVolumeSync() {
    if (ytVolumeSyncInterval) { clearInterval(ytVolumeSyncInterval); ytVolumeSyncInterval = null; }
}

export function ytToggleLoop() {
    ytLoopEnabled = !ytLoopEnabled;
    let label = document.getElementById("yt-loop-label");
    if (label) label.textContent = `Loop: ${ytLoopEnabled ? "On" : "Off"}`;
    let btn = document.getElementById("yt-loop-btn");
    if (btn) btn.classList.toggle("yt-ctrl-active", ytLoopEnabled);
}

// Cycles forward through YT_SPEED_STEPS, wrapping back to the start after
// 2x. Same one-button-cycles-through-states shape as ytToggleLoop() above,
// just with more than two states.
export function ytCycleSpeed() {
    if (!ytPlayer) return;
    let idx = YT_SPEED_STEPS.indexOf(ytPlaybackRate);
    ytPlaybackRate = YT_SPEED_STEPS[(idx + 1) % YT_SPEED_STEPS.length];
    if (ytPlayer.setPlaybackRate) ytPlayer.setPlaybackRate(ytPlaybackRate);
    let label = document.getElementById("yt-speed-label");
    if (label) label.textContent = `Speed: ${ytPlaybackRate}x`;
}

// Fully shuts the player down: stops playback, tears down the YT.Player
// instance (so the next Load starts completely fresh instead of trying to
// reuse a destroyed player), hides the whole player block, and clears the
// link input back to its placeholder — matches "closed = gone, like it was
// never loaded" rather than just pausing/hiding.
export function ytClosePlayer() {
    if (ytPlayer) {
        // Flush the final position before tearing down — closing (unlike a
        // video actually ENDING) should still resume from here next time.
        // Never for a Short — see ytCurrentIsShort.
        if (!ytCurrentIsShort && ytCurrentId && ytPlayer.getCurrentTime) {
            try { saveYtPosition(ytCurrentId, ytPlayer.getCurrentTime()); } catch (e) { /* non-fatal */ }
        }
        try {
            if (ytPlayer.stopVideo) ytPlayer.stopVideo();
            if (ytPlayer.destroy) ytPlayer.destroy();
        } catch (e) { /* non-fatal — we're tearing it down anyway */ }
        ytPlayer = null;
    }
    stopYtVolumeSync();
    ytVolumeDragging = false;
    ytIsPlaying = false;
    ytPendingVideoId = null;
    ytCurrentId = null;
    ytCurrentIsShort = false;
    ytLoopEnabled = false;
    ytPlaybackRate = 1;
    document.getElementById("yt-player-wrap").style.display = "none";
    // Restore the link input (Now Playing label goes back to hidden) so the
    // next paste has a clean field to type into — see setNowPlayingLabel().
    let input = document.getElementById("yt-link-input");
    if (input) { input.style.display = ""; input.value = ""; }
    let nowPlaying = document.getElementById("yt-now-playing");
    if (nowPlaying) nowPlaying.style.display = "none";
    setPlayPauseUI(false);
    let loopLabel = document.getElementById("yt-loop-label");
    if (loopLabel) loopLabel.textContent = "Loop: Off";
    let loopBtn = document.getElementById("yt-loop-btn");
    if (loopBtn) loopBtn.classList.remove("yt-ctrl-active");
    let speedLabel = document.getElementById("yt-speed-label");
    if (speedLabel) speedLabel.textContent = "Speed: 1x";
}
