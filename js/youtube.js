import { escapeHtml } from './utils.js';
import { getYtHistory, saveYtHistory, setRawFlag, YT_HISTORY_MAX_ENTRIES } from './storage.js';
// Forward reference — ui.js lands in Step 7. Only called inside function
// bodies, safe once the full module graph is wired in main.js.
import { showToast } from './ui.js';

let ytPlayer = null, ytApiReady = false, ytLoopEnabled = false, ytPendingVideoId = null;
let ytIsPlaying = false;

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
        playerVars: { rel: 0, origin: window.location.origin },
        events: {
            onReady: (e) => { e.target.setVolume(parseInt(document.getElementById("yt-volume").value)); },
            onStateChange: (e) => {
                if (ytLoopEnabled && e.data === YT.PlayerState.ENDED) { ytPlayer.seekTo(0); ytPlayer.playVideo(); }
                ytIsPlaying = (e.data === YT.PlayerState.PLAYING);
                let btn = document.getElementById("yt-playpause-btn");
                if (btn) btn.innerText = ytIsPlaying ? "⏸ Pause" : "▶ Play";
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
    if (!ytApiReady) { ytPendingVideoId = id; loadYTApiScript(); return; }
    createOrLoadYTPlayer(id);
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

export function ytToggleLoop() {
    ytLoopEnabled = !ytLoopEnabled;
    document.getElementById("yt-loop-btn").innerText = `🔁 Loop: ${ytLoopEnabled ? "On" : "Off"}`;
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
    ytIsPlaying = false;
    ytPendingVideoId = null;
    ytLoopEnabled = false;
    document.getElementById("yt-player-wrap").style.display = "none";
    document.getElementById("yt-link-input").value = "";
    let playBtn = document.getElementById("yt-playpause-btn");
    if (playBtn) playBtn.innerText = "▶ Play";
    let loopBtn = document.getElementById("yt-loop-btn");
    if (loopBtn) loopBtn.innerText = "🔁 Loop: Off";
}
