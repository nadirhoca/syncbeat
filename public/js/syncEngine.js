/**
 * Client-Side Time Synchronization & Drift Detection Engine
 * Strictly follows the Server-Authoritative Synchronization Contract:
 * - Compares local YouTube player time with expected server time every 1.0s.
 * - Handles Live Streams vs Recorded Videos safely (never seeks live streams into invalid buffers).
 * - Avoids buffer abort death loops by ignoring drift while player is BUFFERING, UNSTARTED, or CUED.
 * - Applies a 3.5s stabilization grace period after load or seek before evaluating drift.
 * - If drift > 1.5s on stable playback, calls player.seekTo(expectedServerTime, true).
 */

window.SyncBeatEngine = (function () {
  let player = null;
  let playerReady = false;
  let currentVideoId = null;
  let isPlaying = false;
  let currentElapsedSec = 0;
  let localSyncReceiptTime = 0;
  let duration = 0;
  let driftCheckInterval = null;
  let isSeeking = false;
  let lastActionTime = 0; // Timestamp of last seek or load to enforce stabilization grace period
  let onTickCallbacks = [];

  /**
   * Initializes the synchronization ticker loop (1.0s interval)
   */
  function init(ytPlayerInstance) {
    player = ytPlayerInstance;
    playerReady = true;

    if (driftCheckInterval) clearInterval(driftCheckInterval);
    driftCheckInterval = setInterval(checkDriftAndTick, 1000);
  }

  /**
   * Sets the YouTube Player instance reference
   */
  function setPlayer(ytPlayer) {
    player = ytPlayer;
    playerReady = true;
  }

  /**
   * Authoritative sync payload received from the server
   * @param {Object} syncState 
   */
  function applyServerState(syncState) {
    if (!syncState) return;

    isPlaying = Boolean(syncState.isPlaying);
    currentElapsedSec = Number(syncState.currentElapsedSec) || 0;
    localSyncReceiptTime = Date.now();
    duration = Number(syncState.duration) || 0;

    const newVideoId = syncState.currentVideoId;

    if (player && playerReady && typeof player.loadVideoById === 'function') {
      let currentLoaded = null;
      try {
        if (typeof player.getVideoData === 'function' && player.getVideoData()) {
          currentLoaded = player.getVideoData().video_id;
        }
      } catch (e) {}

      const targetTime = calculateExpectedServerTime();

      if (newVideoId && currentLoaded !== newVideoId) {
        currentVideoId = newVideoId;
        lastActionTime = Date.now();

        console.log(`[SyncEngine] Loading track ${newVideoId} (duration=${duration}s, targetTime=${targetTime.toFixed(1)}s)`);

        // If finite recorded video, pass startSeconds bounded by duration
        if (duration > 0) {
          const boundedStart = Math.floor(targetTime % duration);
          player.loadVideoById({
            videoId: newVideoId,
            startSeconds: boundedStart
          });
        } else {
          // Live stream or unknown duration: load cleanly at live broadcast head
          player.loadVideoById({
            videoId: newVideoId
          });
        }

        // If server says paused, pause shortly after loading
        if (!isPlaying) {
          setTimeout(() => {
            if (player && player.pauseVideo) player.pauseVideo();
          }, 400);
        }
      } else {
        // Video ID is the same; reconcile state
        alignPlayerState(targetTime);
      }
    } else {
      currentVideoId = newVideoId;
    }
  }

  /**
   * Computes expected server time at the current local millisecond
   * @returns {number}
   */
  function calculateExpectedServerTime() {
    if (!isPlaying) {
      return Math.max(0, currentElapsedSec);
    }
    const elapsedSinceReceiptSec = (Date.now() - localSyncReceiptTime) / 1000;
    return Math.max(0, currentElapsedSec + elapsedSinceReceiptSec);
  }

  /**
   * Checks for drift every 1 second and aligns local player with server
   */
  function checkDriftAndTick() {
    if (!player || !playerReady || typeof player.getCurrentTime !== 'function') {
      return;
    }

    // Do not interfere while user/admin is dragging scrubber
    if (isSeeking) return;

    let playerState = -1;
    try {
      if (typeof player.getPlayerState === 'function') {
        playerState = player.getPlayerState();
      }
    } catch (e) {
      return;
    }

    const expectedTime = calculateExpectedServerTime();
    let localTime = 0;
    try {
      localTime = player.getCurrentTime() || 0;
    } catch (e) {}

    let playerDuration = duration;
    try {
      if (typeof player.getDuration === 'function') {
        const d = player.getDuration();
        if (d && d > 0) playerDuration = d;
      }
    } catch (e) {}

    // Check player duration and update if available
    if (playerDuration > 0 && Math.abs(playerDuration - duration) > 1) {
      duration = playerDuration;
      if (window.SyncBeatApp && window.SyncBeatApp.notifyDuration) {
        window.SyncBeatApp.notifyDuration(playerDuration);
      }
    }

    // CRITICAL FIX: Do NOT perform seek operations while buffering or unstarted!
    // PlayerState:
    // -1 = UNSTARTED, 1 = PLAYING, 2 = PAUSED, 3 = BUFFERING, 5 = CUED
    const isBufferingOrStarting = (playerState === 3 || playerState === -1 || playerState === 5);
    const hasGracePeriodExpired = (Date.now() - lastActionTime) > 3500;

    // Only evaluate drift if playback has stabilized and is actively playing
    if (!isBufferingOrStarting && hasGracePeriodExpired && playerState === 1) {
      // If duration is finite (> 0), perform modulo drift check
      if (duration > 0) {
        const effectiveExpected = expectedTime % duration;
        const drift = Math.abs(localTime - effectiveExpected);

        if (drift > 1.5) {
          console.warn(`[SyncEngine] Drift detected: ${drift.toFixed(2)}s > 1.5s tolerance. Seeking to ${effectiveExpected.toFixed(2)}s.`);
          lastActionTime = Date.now();
          player.seekTo(effectiveExpected, true);
          if (window.SyncBeatApp && window.SyncBeatApp.showDriftBadge) {
            window.SyncBeatApp.showDriftBadge(drift);
          }
        }
      }
      // Note: On 24/7 live streams (duration == 0), YouTube's live CDN naturally keeps
      // viewers synchronized at the broadcast head without destructive seeking.
    }

    // Playback state alignment (when not actively buffering)
    if (!isBufferingOrStarting) {
      if (isPlaying && playerState === 2) {
        // Server says PLAY, but player is PAUSED
        if (window.SyncBeatAudioUnlock && window.SyncBeatAudioUnlock.isUnlocked()) {
          try { player.playVideo(); } catch (e) {}
        }
      } else if (!isPlaying && playerState === 1) {
        // Server says PAUSE, but player is PLAYING
        try { player.pauseVideo(); } catch (e) {}
      }
    }

    // Emit tick for UI progress bars & time displays
    onTickCallbacks.forEach(cb => {
      try {
        cb({
          currentTime: isPlaying ? localTime : expectedTime,
          expectedServerTime: expectedTime,
          duration: playerDuration,
          isPlaying,
          playerState
        });
      } catch (err) {
        console.error(err);
      }
    });
  }

  /**
   * Force manual immediate resynchronization
   */
  function forceResync() {
    if (!player || !playerReady) return;
    lastActionTime = Date.now();
    const expectedTime = calculateExpectedServerTime();

    if (duration > 0) {
      const target = expectedTime % duration;
      console.log(`[SyncEngine] Force Resync invoked. Seeking to ${target.toFixed(2)}s`);
      player.seekTo(target, true);
    }

    if (isPlaying) {
      try { player.playVideo(); } catch (e) {}
    } else {
      try { player.pauseVideo(); } catch (e) {}
    }
  }

  function alignPlayerState(targetTime) {
    if (!player || !playerReady) return;

    if (isPlaying) {
      if (player.getPlayerState && player.getPlayerState() === 2) {
        if (window.SyncBeatAudioUnlock && window.SyncBeatAudioUnlock.isUnlocked()) {
          player.playVideo();
        }
      }
    } else {
      player.pauseVideo();
    }
  }

  function onTick(callback) {
    if (typeof callback === 'function') {
      onTickCallbacks.push(callback);
    }
  }

  function setIsSeeking(seeking) {
    isSeeking = seeking;
    if (!seeking) {
      lastActionTime = Date.now();
    }
  }

  return {
    init,
    setPlayer,
    applyServerState,
    calculateExpectedServerTime,
    forceResync,
    onTick,
    setIsSeeking,
    isPlaying: () => isPlaying,
    getDuration: () => duration
  };
})();
