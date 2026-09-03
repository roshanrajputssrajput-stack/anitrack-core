// content.js — AniTrack v12.1
(function () {
  // ─── RESUME: apply a pending saved position exactly once per page load ──
  // popup.js writes ANITRACK_PENDING_RESUME_KEY to chrome.storage.local right
  // before opening the tab. We check for it on load, and if it matches THIS
  // exact URL, seek the video to that position once metadata is available.
  // Guarded so it can only ever fire once per page load, even if the player
  // element gets swapped out later (ads, quality switch) — per spec, the
  // seek happens exactly once, not once per video element.
  const PENDING_RESUME_KEY = 'anitrack_pending_resume';
  let resumeConsumedThisLoad = false;

  function tryApplyPendingResume(video) {
    if (resumeConsumedThisLoad) return;
    chrome.storage.local.get(PENDING_RESUME_KEY, (data) => {
      const pending = data[PENDING_RESUME_KEY];
      if (!pending || resumeConsumedThisLoad) return;
      // Must be for THIS exact page, and recent (avoid a stale resume from
      // an old click firing on some unrelated later visit to the same URL).
      if (pending.url !== window.location.href) return;
      if (!pending.positionSec || Date.now() - (pending.setAt || 0) > 10 * 60 * 1000) return;

      const applySeek = () => {
        if (resumeConsumedThisLoad) return;
        const dur = video.duration;
        if (!dur || isNaN(dur)) return; // duration not known yet, wait for loadedmetadata
        const pos = pending.positionSec;
        // Skip trivial resumes (under 10s in) and skip if the saved position
        // is basically the end of the episode (within 15s) or past duration —
        // those aren't meaningful resume points.
        if (pos < 10 || pos > dur - 15) {
          resumeConsumedThisLoad = true;
          chrome.storage.local.remove(PENDING_RESUME_KEY);
          return;
        }
        resumeConsumedThisLoad = true; // guarantee exactly-once before mutating currentTime
        try { video.currentTime = Math.min(pos, dur - 1); } catch (_) {}
        chrome.storage.local.remove(PENDING_RESUME_KEY);
      };

      if (video.readyState >= 1 && video.duration) {
        applySeek();
      } else {
        video.addEventListener('loadedmetadata', applySeek, { once: true });
      }
    });
  }

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === 'EXTRACT_PAGE_INFO') {
      // The <video> element often mounts asynchronously (player JS, ads,
      // lazy loading) — checking exactly once at request-time was wrongly
      // classifying real anime pages as manga if the player hadn't loaded
      // yet. Retry briefly before concluding there's genuinely no video.
      (async () => {
        let hasVideo = !!document.querySelector('video');
        let attempts = 0;
        while (!hasVideo && attempts < 4) {
          await new Promise(r => setTimeout(r, 500));
          hasVideo = !!document.querySelector('video');
          attempts++;
        }
        sendResponse({
          url: window.location.href,
          title: document.title,
          metaTitle: document.querySelector('meta[property="og:title"]')?.content || '',
          h1: document.querySelector('h1')?.innerText?.trim() || '',
          hasVideo
        });
      })();
      return true; // keep the message channel open for the async response above
    }
  });

  // ─── EVENT-DRIVEN VIDEO TRACKING ───────────────────────────────
  // Real state machine instead of polling: only accumulates watched time
  // between actual timeupdate ticks while genuinely playing — not paused,
  // not seeking, not buffering. Messages are throttled (every 10s OR every
  // 5% progress, whichever comes first) instead of every tick, per the
  // "minimize runtime messaging" requirement. Completion is percentage-based
  // (95% watched, or under 2 min remaining) rather than a fixed time guess,
  // and fires exactly once per video via a reset-on-source-change guard.

  let currentVideo = null;
  let state = { isSeeking: false, isBuffering: false, lastTickTime: null };
  let watchedSinceLastSend = 0;   // accumulated seconds not yet reported
  let lastSentPct = 0;            // for the "every 5%" throttle rule
  let lastSendAt = 0;             // for the "every 10s" throttle rule
  let completedFired = false;     // guards against duplicate completion events

  function resetForNewVideo() {
    watchedSinceLastSend = 0;
    lastSentPct = 0;
    lastSendAt = 0;
    completedFired = false;
    state = { isSeeking: false, isBuffering: false, lastTickTime: null };
  }

  function sendProgress(video, force) {
    if (!video.duration || isNaN(video.duration)) return;
    const pct = (video.currentTime / video.duration) * 100;
    const dueByTime = Date.now() - lastSendAt >= 10000;
    const dueByProgress = Math.abs(pct - lastSentPct) >= 5;
    if (!force && !dueByTime && !dueByProgress) return;

    chrome.runtime.sendMessage({
      type: 'VIDEO_PROGRESS',
      currentTime: video.currentTime,
      duration: video.duration,
      watchedDelta: Math.round(watchedSinceLastSend),
      playbackRate: video.playbackRate || 1,
      url: window.location.href
    }).catch(() => {});

    watchedSinceLastSend = 0;
    lastSentPct = pct;
    lastSendAt = Date.now();

    // Percentage-based completion, not a fixed-minutes guess. Fires once.
    const remaining = video.duration - video.currentTime;
    if (!completedFired && (pct >= 95 || remaining < 120)) {
      completedFired = true;
      chrome.runtime.sendMessage({
        type: 'EPISODE_COMPLETE',
        url: window.location.href,
        duration: video.duration
      }).catch(() => {});
    }
  }

  function attachTracking(video) {
    if (currentVideo === video) return; // already tracking this exact element
    currentVideo = video;
    resetForNewVideo();
    tryApplyPendingResume(video);

    video.addEventListener('timeupdate', () => {
      // Ignore ticks while seeking/buffering — that's not real watched time,
      // just the player catching up or you scrubbing the timeline.
      if (state.isSeeking || state.isBuffering || video.paused) {
        state.lastTickTime = video.currentTime;
        return;
      }
      if (state.lastTickTime != null) {
        const delta = video.currentTime - state.lastTickTime;
        // Reject negative (rewind/seek-without-event) and large jumps
        // (skip-intro buttons, seeking that slipped past the seeking event)
        if (delta > 0 && delta <= 2) watchedSinceLastSend += delta;
      }
      state.lastTickTime = video.currentTime;
      sendProgress(video, false);
    });

    video.addEventListener('seeking', () => { state.isSeeking = true; });
    video.addEventListener('seeked', () => { state.isSeeking = false; state.lastTickTime = video.currentTime; });
    video.addEventListener('waiting', () => { state.isBuffering = true; });
    video.addEventListener('playing', () => { state.isBuffering = false; state.lastTickTime = video.currentTime; });
    video.addEventListener('pause', () => { sendProgress(video, true); }); // flush immediately on pause
    video.addEventListener('ratechange', () => { /* playbackRate read fresh in sendProgress, nothing to store */ });
    video.addEventListener('ended', () => { sendProgress(video, true); });
  }

  // Sites can swap the player element dynamically (ads, quality switches,
  // SPA episode navigation) — watch for that instead of assuming one
  // <video> element lives for the whole page lifetime.
  function scanForVideo() {
    const video = document.querySelector('video');
    if (video) attachTracking(video);
  }
  scanForVideo();
  new MutationObserver(scanForVideo).observe(document.body, { childList: true, subtree: true });
})();
