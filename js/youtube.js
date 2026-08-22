import { escapeHtml } from './utils.js';
import { getYtHistory, saveYtHistory, setRawFlag, YT_HISTORY_MAX_ENTRIES } from './storage.js';
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
// Cycled by ytCycleSpeed() below — 1x sits in the middle so the common
// "slightly faster" bump (1.25x/1.5x) is one tap away either direction from
// the default, same spirit as the Loop toggle being one tap.
const YT_SPEED_STEPS = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];
let ytPlaybackRate = 1;

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
    if (ytPlayer && ytPlayer.loadVideoById) { ytPlayer.loadVideoById(id); return; }
    let container = document.getElementById('yt-player');
    if (!container) return;
    ytPlayer = new YT.Player('yt-player', {
        height: '160', width: '100%', videoId: id,
        host: 'https://www.youtube-nocookie.com',
        // controls:0 hides YouTube's own control bar entirely — that bar's
        // buttons (CC/settings/fullscreen/volume) render at a fixed native
        // size YouTube itself sets, and CSS can't reach into the iframe to
        // shrink them; on a player this narrow they end up oversized and
        // crowd out the ones people actually need. The custom row below
        // (seek bar + Play/Pause/Speed/Loop/Close, already on the page)
        // replaces it with something sized to fit here. disablekb keeps
        // stray keyboard shortcuts from reaching a hidden control surface;
        // fs:0/iv_load_policy:3/modestbranding:1 drop the fullscreen button,
        // video annotations, and YouTube logo the native bar would've had.
        playerVars: { rel: 0, origin: window.location.origin, controls: 0, disablekb: 1, fs: 0, iv_load_policy: 3, modestbranding: 1 },
        events: {
            onReady: (e) => {
                e.target.setVolume(parseInt(document.getElementById("yt-volume").value));
                // Re-apply whatever speed was already selected — matters when
                // loadYoutubeLink() swaps in a new video without the player
                // having been closed first (createOrLoadYTPlayer's
                // loadVideoById branch resets YouTube's own rate to 1x, but
                // our button/state should stay consistent with what's shown).
                if (ytPlaybackRate !== 1) e.target.setPlaybackRate(ytPlaybackRate);
                updateYtProgress();
            },
            onStateChange: (e) => {
                if (ytLoopEnabled && e.data === YT.PlayerState.ENDED) { ytPlayer.seekTo(0); ytPlayer.playVideo(); }
                ytIsPlaying = (e.data === YT.PlayerState.PLAYING);
                let btn = document.getElementById("yt-playpause-btn");
                if (btn) btn.innerText = ytIsPlaying ? "⏸ Pause" : "▶ Play";
                if (ytIsPlaying) startYtProgressLoop(); else stopYtProgressLoop();
                if (e.data === YT.PlayerState.ENDED && !ytLoopEnabled) updateYtProgress();
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
    label.textContent = `▶ Now Playing: ${title || id}`;
    label.style.display = "block";
    input.style.display = "none";
}

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

export function ytSetVolume(v) { if (ytPlayer && ytPlayer.setVolume) ytPlayer.setVolume(v); }

// ----------------- CUSTOM SEEK BAR -----------------
// Replaces the scrubbing YouTube's native control bar used to provide
// (hidden now via controls:0 above — see createOrLoadYTPlayer()'s comment).
let ytProgressInterval = null;
// True for as long as the user has the seek handle down — the polling loop
// below skips updating the bar/time while true so a live position update
// doesn't fight the drag and yank the handle back mid-gesture.
let ytSeeking = false;

function startYtProgressLoop() {
    stopYtProgressLoop();
    ytProgressInterval = setInterval(updateYtProgress, 500);
}
function stopYtProgressLoop() {
    if (ytProgressInterval) { clearInterval(ytProgressInterval); ytProgressInterval = null; }
}
function formatYtTime(sec) {
    sec = Math.max(0, Math.floor(sec || 0));
    let m = Math.floor(sec / 60), s = sec % 60;
    return `${m}:${String(s).padStart(2, "0")}`;
}
function updateYtProgress() {
    if (!ytPlayer || ytSeeking || !ytPlayer.getCurrentTime) return;
    let cur = ytPlayer.getCurrentTime() || 0;
    let dur = ytPlayer.getDuration() || 0;
    let seekEl = document.getElementById("yt-seek");
    let curEl = document.getElementById("yt-current-time");
    let durEl = document.getElementById("yt-duration-time");
    if (seekEl && dur > 0) seekEl.value = (cur / dur) * 100;
    if (curEl) curEl.textContent = formatYtTime(cur);
    if (durEl) durEl.textContent = formatYtTime(dur);
}
// Fires continuously while the handle is being dragged (range input's
// `oninput`) — updates only the time label so it tracks the drag; the
// actual seek only happens once on release (ytSeekCommit), since seeking
// the real player on every pixel of drag would be choppy and wasteful.
export function ytSeekPreview(percent) {
    ytSeeking = true;
    if (!ytPlayer || !ytPlayer.getDuration) return;
    let dur = ytPlayer.getDuration() || 0;
    let curEl = document.getElementById("yt-current-time");
    if (curEl) curEl.textContent = formatYtTime((percent / 100) * dur);
}
// Fires once on release (range input's `onchange`) — commits the seek.
export function ytSeekCommit(percent) {
    if (ytPlayer && ytPlayer.seekTo && ytPlayer.getDuration) {
        let dur = ytPlayer.getDuration() || 0;
        ytPlayer.seekTo((percent / 100) * dur, true);
    }
    ytSeeking = false;
}

export function ytToggleLoop() {
    ytLoopEnabled = !ytLoopEnabled;
    document.getElementById("yt-loop-btn").innerText = `🔁 Loop: ${ytLoopEnabled ? "On" : "Off"}`;
}

// Cycles forward through YT_SPEED_STEPS, wrapping back to the start after
// 2x. Same one-button-cycles-through-states shape as ytToggleLoop() above,
// just with more than two states.
export function ytCycleSpeed() {
    if (!ytPlayer) return;
    let idx = YT_SPEED_STEPS.indexOf(ytPlaybackRate);
    ytPlaybackRate = YT_SPEED_STEPS[(idx + 1) % YT_SPEED_STEPS.length];
    if (ytPlayer.setPlaybackRate) ytPlayer.setPlaybackRate(ytPlaybackRate);
    let btn = document.getElementById("yt-speed-btn");
    if (btn) btn.innerText = `⏩ Speed: ${ytPlaybackRate}x`;
}

// Fully shuts the player down: stops playback, tears down the YT.Player
// instance (so the next Load starts completely fresh instead of trying to
// reuse a destroyed player), hides the whole player block, and clears the
// link input back to its placeholder — matches "closed = gone, like it was
// never loaded" rather than just pausing/hiding.
export function ytClosePlayer() {
    if (ytPlayer) {
        try {
            if (ytPlayer.stopVideo) ytPlayer.stopVideo();
            if (ytPlayer.destroy) ytPlayer.destroy();
        } catch (e) { /* non-fatal — we're tearing it down anyway */ }
        ytPlayer = null;
    }
    stopYtProgressLoop();
    ytSeeking = false;
    ytIsPlaying = false;
    ytPendingVideoId = null;
    ytCurrentId = null;
    ytLoopEnabled = false;
    ytPlaybackRate = 1;
    document.getElementById("yt-player-wrap").style.display = "none";
    // Restore the link input (Now Playing label goes back to hidden) so the
    // next paste has a clean field to type into — see setNowPlayingLabel().
    let input = document.getElementById("yt-link-input");
    if (input) { input.style.display = ""; input.value = ""; }
    let nowPlaying = document.getElementById("yt-now-playing");
    if (nowPlaying) nowPlaying.style.display = "none";
    let seekEl = document.getElementById("yt-seek");
    if (seekEl) seekEl.value = 0;
    let curEl = document.getElementById("yt-current-time");
    if (curEl) curEl.textContent = "0:00";
    let durEl = document.getElementById("yt-duration-time");
    if (durEl) durEl.textContent = "0:00";
    let playBtn = document.getElementById("yt-playpause-btn");
    if (playBtn) playBtn.innerText = "▶ Play";
    let loopBtn = document.getElementById("yt-loop-btn");
    if (loopBtn) loopBtn.innerText = "🔁 Loop: Off";
    let speedBtn = document.getElementById("yt-speed-btn");
    if (speedBtn) speedBtn.innerText = "⏩ Speed: 1x";
}
