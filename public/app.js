/**
 * SyncBeat - Frontend Client Application
 * Handles YouTube IFrame API, Socket.io real-time synchronization,
 * mobile audio unlocking, anti-abuse cooldown tracking, and room UI.
 */

(function () {
  'use strict';

  // ==========================================
  // STATE MANAGEMENT
  // ==========================================
  let socket = null;
  let ytPlayer = null;
  let isYtApiReady = false;
  let isPlayerReady = false;
  let audioUnlocked = false;

  let currentRoom = null;
  let userRole = 'client'; // 'admin' | 'client'
  let currentTrackId = null;
  let isPlaying = false;
  let startedAt = 0;
  let trackDuration = 210;
  let currentElapsedSec = 0;
  let progressInterval = null;

  // Anti-Abuse Rate Limit State
  let rateLimitCooldownTimer = null;
  let cooldownRemaining = 0;
  let remainingChangesInWindow = 2;

  // DOM Elements
  const lobbyScreen = document.getElementById('lobby-screen');
  const roomDashboard = document.getElementById('room-dashboard');
  const toastContainer = document.getElementById('toast-container');
  const audioUnlockBanner = document.getElementById('audio-unlock-banner');
  const btnUnlockAudio = document.getElementById('btn-unlock-audio');
  const unmuteOverlay = document.getElementById('unmute-overlay');
  const btnUnmuteOverlay = document.getElementById('btn-unmute-overlay');

  // Lobby Form Elements
  const tabJoin = document.getElementById('tab-join');
  const tabCreate = document.getElementById('tab-create');
  const joinForm = document.getElementById('join-room-form');
  const createForm = document.getElementById('create-room-form');
  const btnDemoStart = document.getElementById('btn-demo-start');

  // Dashboard Header Elements
  const displayRoomName = document.getElementById('display-room-name');
  const syncStatusPill = document.getElementById('sync-status-pill');
  const syncStatusText = document.getElementById('sync-status-text');
  const syncDriftVal = document.getElementById('sync-drift-val');
  const roleBadge = document.getElementById('role-badge');
  const roleText = document.getElementById('role-text');
  const displayListenerCount = document.getElementById('display-listener-count');
  const btnLeaveRoom = document.getElementById('btn-leave-room');
  const btnDeleteRoom = document.getElementById('btn-delete-room');

  // Player & Controls Elements
  const playerLoadingOverlay = document.getElementById('player-loading-overlay');
  const currentTrackThumb = document.getElementById('current-track-thumb');
  const currentTrackTitle = document.getElementById('current-track-title');
  const currentTrackAuthor = document.getElementById('current-track-author');
  const equalizerBars = document.getElementById('equalizer-bars');
  const trackPlayingLabel = document.getElementById('track-playing-label');
  const rateLimitPill = document.getElementById('rate-limit-pill');
  const rateLimitPillText = document.getElementById('rate-limit-pill-text');

  const timeCurrent = document.getElementById('time-current');
  const timeTotal = document.getElementById('time-total');
  const progressBar = document.getElementById('progress-bar');
  const progressContainer = document.getElementById('progress-container');

  const btnTogglePlay = document.getElementById('btn-toggle-play');
  const iconPlay = document.getElementById('icon-play');
  const iconPause = document.getElementById('icon-pause');
  const btnSkipTrack = document.getElementById('btn-skip-track');
  const btnForceResync = document.getElementById('btn-force-resync');

  const btnMute = document.getElementById('btn-mute');
  const iconVolumeHigh = document.getElementById('icon-volume-high');
  const iconVolumeMuted = document.getElementById('icon-volume-muted');
  const volumeSlider = document.getElementById('volume-slider');
  const volumeLabel = document.getElementById('volume-label');

  // Input & Queue Elements
  const inputYoutubeUrl = document.getElementById('input-youtube-url');
  const btnPlayNow = document.getElementById('btn-play-now');
  const btnAddQueue = document.getElementById('btn-add-queue');
  const rateLimitCounterBox = document.getElementById('rate-limit-counter-box');
  const rateLimitCounterText = document.getElementById('rate-limit-counter-text');
  const queueList = document.getElementById('queue-list');
  const queueCountBadge = document.getElementById('queue-count-badge');
  const btnClearQueue = document.getElementById('btn-clear-queue');
  const usersList = document.getElementById('users-list');
  const activityFeed = document.getElementById('activity-feed');
  const chatForm = document.getElementById('chat-form');
  const chatInput = document.getElementById('chat-input');

  // ==========================================
  // UTILITIES & HELPERS
  // ==========================================

  function formatTime(seconds) {
    if (isNaN(seconds) || seconds < 0) return '00:00';
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  }

  function showToast(title, message, type = 'error') {
    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;

    let iconSvg = '';
    if (type === 'error') {
      iconSvg = `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="8" x2="12" y2="12"></line><line x1="12" y1="16" x2="12.01" y2="16"></line></svg>`;
    } else if (type === 'warning') {
      iconSvg = `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"></path><line x1="12" y1="9" x2="12" y2="13"></line><line x1="12" y1="17" x2="12.01" y2="17"></line></svg>`;
    } else {
      iconSvg = `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"></polyline></svg>`;
    }

    toast.innerHTML = `
      <div class="toast-icon">${iconSvg}</div>
      <div class="toast-body">
        <strong>${title}</strong>
        <div>${message}</div>
      </div>
      <button class="toast-close" title="Close">&times;</button>
    `;

    toast.querySelector('.toast-close').addEventListener('click', () => {
      toast.remove();
    });

    toastContainer.appendChild(toast);

    setTimeout(() => {
      if (toast.parentNode) {
        toast.style.opacity = '0';
        toast.style.transition = 'opacity 0.25s ease';
        setTimeout(() => toast.remove(), 250);
      }
    }, 4500);
  }

  function showToastWithAction(title, message, actionLabel, onAction) {
    const toast = document.createElement('div');
    toast.className = 'toast toast-warning';

    const iconSvg = `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"></path><line x1="12" y1="9" x2="12" y2="13"></line><line x1="12" y1="17" x2="12.01" y2="17"></line></svg>`;

    toast.innerHTML = `
      <div class="toast-icon">${iconSvg}</div>
      <div class="toast-body">
        <strong>${title}</strong>
        <div style="margin-bottom: 8px;">${message}</div>
        <div style="display: flex; gap: 8px; flex-wrap: wrap;">
          <button class="toast-action-btn" style="background: #e11d48; color: #fff; border: none; padding: 6px 14px; border-radius: 6px; font-weight: 700; font-size: 0.8rem; cursor: pointer; transition: opacity 0.2s;">
            ${actionLabel}
          </button>
        </div>
      </div>
      <button class="toast-close" title="Close">&times;</button>
    `;

    toast.querySelector('.toast-action-btn').addEventListener('click', () => {
      toast.remove();
      if (typeof onAction === 'function') onAction();
    });

    toast.querySelector('.toast-close').addEventListener('click', () => {
      toast.remove();
    });

    toastContainer.appendChild(toast);

    setTimeout(() => {
      if (toast.parentNode) {
        toast.style.opacity = '0';
        toast.style.transition = 'opacity 0.25s ease';
        setTimeout(() => toast.remove(), 250);
      }
    }, 10000);
  }

  function addActivity(text, type = 'system', sender = '') {
    const item = document.createElement('div');
    item.className = `activity-msg ${type}`;
    const now = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });

    let senderHtml = sender ? `<span class="activity-sender">${sender}:</span> ` : '';
    item.innerHTML = `
      <span class="activity-time">${now}</span>
      <span class="activity-body">${senderHtml}${text}</span>
    `;

    activityFeed.appendChild(item);
    activityFeed.scrollTop = activityFeed.scrollHeight;
  }

  // ==========================================
  // BROWSER AUDIO UNLOCK (MOBILE & AUTOPLAY)
  // Requirement: Tapping "Join Room" counts as user interaction
  // ==========================================

  function primeAudioContext() {
    try {
      const AudioContextClass = window.AudioContext || window.webkitAudioContext;
      if (AudioContextClass) {
        const ctx = new AudioContextClass();
        if (ctx.state === 'suspended') {
          ctx.resume();
        }
        // Play brief silent buffer to unlock audio hardware
        const buffer = ctx.createBuffer(1, 1, 22050);
        const source = ctx.createBufferSource();
        source.buffer = buffer;
        source.connect(ctx.destination);
        source.start(0);
      }
      audioUnlocked = true;
      audioUnlockBanner.classList.add('hidden');
    } catch (e) {
      console.warn('Audio priming note:', e);
    }

    // Directly command YouTube player to unmute and play if available
    if (ytPlayer && typeof ytPlayer.unMute === 'function') {
      try {
        ytPlayer.unMute();
        ytPlayer.setVolume(85);
        ytPlayer.playVideo();
      } catch (e) {}
    }
  }

  function triggerDirectAudioUnlock() {
    primeAudioContext();
    if (ytPlayer && typeof ytPlayer.unMute === 'function') {
      try {
        ytPlayer.unMute();
        ytPlayer.setVolume(85);
        ytPlayer.playVideo();
      } catch (e) {}
    }
    if (unmuteOverlay) unmuteOverlay.classList.add('hidden');
    if (audioUnlockBanner) audioUnlockBanner.classList.add('hidden');
  }

  btnUnlockAudio.addEventListener('click', () => {
    triggerDirectAudioUnlock();
    showToast('Audio Unlocked', 'Audio playback enabled for this session.', 'success');
  });

  if (btnUnmuteOverlay) {
    btnUnmuteOverlay.addEventListener('click', (e) => {
      e.stopPropagation();
      triggerDirectAudioUnlock();
      showToast('Sound Playing', 'Audio unmuted at 85% volume.', 'success');
    });
  }

  // ==========================================
  // YOUTUBE IFRAME PLAYER API INTEGRATION
  // ==========================================

  window.onYouTubeIframeAPIReady = function () {
    isYtApiReady = true;
    initYouTubePlayer(currentTrackId || 'Dx5qFachd3A');
  };

  // If YT API is already loaded before handler attachment
  if (window.YT && window.YT.Player) {
    isYtApiReady = true;
    initYouTubePlayer('Dx5qFachd3A');
  }

  function initYouTubePlayer(initialVideoId) {
    if (ytPlayer || !window.YT || !window.YT.Player) return;

    try {
      ytPlayer = new window.YT.Player('youtube-player', {
        videoId: initialVideoId,
        playerVars: {
          enablejsapi: 1,
          autoplay: 1,
          controls: 1, // Provide fallback native controls so users can directly interact if needed
          disablekb: 0,
          modestbranding: 1,
          rel: 0,
          fs: 0,
          playsinline: 1,
          origin: window.location.origin,
        },
        events: {
          onReady: onPlayerReady,
          onStateChange: onPlayerStateChange,
          onError: onPlayerError,
        },
      });

      // Safety timeout: dismiss loading overlay within 3s in case onReady was delayed
      setTimeout(() => {
        if (playerLoadingOverlay) {
          playerLoadingOverlay.classList.add('hidden');
        }
        isPlayerReady = true;
      }, 3000);
    } catch (err) {
      console.warn('YouTube Player initialization catch:', err);
    }
  }

  function onPlayerReady(event) {
    isPlayerReady = true;
    if (playerLoadingOverlay) {
      playerLoadingOverlay.classList.add('hidden');
    }

    // Set iframe permissions for autoplay and encrypted media
    const iframe = document.querySelector('#youtube-player');
    if (iframe && iframe.tagName === 'IFRAME') {
      iframe.setAttribute('allow', 'accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share');
    }

    // Set initial volume from slider
    const initialVol = parseInt(volumeSlider.value, 10) || 85;
    try {
      ytPlayer.setVolume(initialVol);
      if (audioUnlocked) {
        ytPlayer.unMute();
      }
    } catch (e) {}

    // If room state already loaded before player ready, synchronize now
    if (currentTrackId) {
      syncPlayerToRoom();
    }
  }

  function onPlayerStateChange(event) {
    // Check if player is playing but muted by browser autoplay policy
    try {
      if (event.data === window.YT.PlayerState.PLAYING) {
        if (ytPlayer.isMuted() || ytPlayer.getVolume() === 0) {
          unmuteOverlay.classList.remove('hidden');
          audioUnlockBanner.classList.remove('hidden');
        } else {
          unmuteOverlay.classList.add('hidden');
          audioUnlockBanner.classList.add('hidden');
        }
      }
    } catch (e) {}

    // YT.PlayerState: -1 (UNSTARTED), 0 (ENDED), 1 (PLAYING), 2 (PAUSED), 3 (BUFFERING), 5 (CUED)
    if (event.data === window.YT.PlayerState.PLAYING) {
      equalizerBars.classList.add('active');
      iconPlay.classList.add('hidden');
      iconPause.classList.remove('hidden');
      trackPlayingLabel.textContent = 'PLAYING NOW';
      trackPlayingLabel.className = 'live-pill';
    } else if (event.data === window.YT.PlayerState.PAUSED) {
      equalizerBars.classList.remove('active');
      iconPlay.classList.remove('hidden');
      iconPause.classList.add('hidden');
      trackPlayingLabel.textContent = 'PAUSED';
      trackPlayingLabel.className = 'pill-badge';
    } else if (event.data === window.YT.PlayerState.ENDED) {
      equalizerBars.classList.remove('active');
      // When current track ends, advance queue
      if (userRole === 'admin') {
        socket.emit('change_track', { isSkip: true });
      }
    }
  }

  function onPlayerError(event) {
    console.warn('YouTube Player Error code:', event.data);
    let errorMsg = 'Could not load video.';
    if (event.data === 101 || event.data === 150) {
      errorMsg = 'This video does not allow embedded playback. Skipping to next in queue.';
      if (userRole === 'admin' && socket) {
        socket.emit('change_track', { isSkip: true });
      }
    } else if (event.data === 100) {
      errorMsg = 'Video not found or removed.';
    }
    showToast('Playback Notice', errorMsg, 'warning');
  }

  // ==========================================
  // SYNCHRONIZATION ENGINE
  // Math: elapsedSeconds = (Date.now() - startedAt) / 1000
  // Drift threshold: ±1.0 second
  // ==========================================

  function calculateElapsedSeconds() {
    if (!isPlaying) return currentElapsedSec;
    const elapsed = (Date.now() - startedAt) / 1000;
    return Math.max(0, elapsed);
  }

  function syncPlayerToRoom(manual = false) {
    if (!isPlayerReady || !ytPlayer || !currentTrackId) return;

    const targetElapsed = calculateElapsedSeconds();
    let currentYtTime = 0;
    let isLiveStream = false;

    try {
      currentYtTime = ytPlayer.getCurrentTime() || 0;
      const dur = ytPlayer.getDuration() || 0;
      if (dur === 0 || dur > 86400) {
        isLiveStream = true;
      }
    } catch (e) {
      // Ignore if not fully initialized
    }

    const drift = Math.abs(currentYtTime - targetElapsed);
    if (isLiveStream || currentYtTime > 100000) {
      syncDriftVal.textContent = `Live Stream`;
    } else {
      syncDriftVal.textContent = `±${drift.toFixed(2)}s`;
    }

    if ((drift > 1.0 && !isLiveStream) || manual) {
      syncStatusPill.className = 'sync-pill drifted';
      syncStatusText.textContent = 'Re-aligning';
      try {
        ytPlayer.seekTo(targetElapsed, true);
      } catch (e) {}

      setTimeout(() => {
        syncStatusPill.className = 'sync-pill synced';
        syncStatusText.textContent = 'Server Synced';
      }, 700);

      if (manual) {
        showToast('Manual Sync', `Aligned audio with server time (drift: ${drift.toFixed(2)}s)`, 'success');
      }
    } else {
      syncStatusPill.className = 'sync-pill synced';
      syncStatusText.textContent = 'Server Synced';
    }

    if (isPlaying) {
      try {
        const state = ytPlayer.getPlayerState();
        if (state !== window.YT.PlayerState.PLAYING && state !== window.YT.PlayerState.BUFFERING) {
          ytPlayer.playVideo();
        }
      } catch (e) {}
    } else {
      try {
        ytPlayer.pauseVideo();
      } catch (e) {}
    }
  }

  // Continuous Progress Bar Tick (every 250ms)
  function startProgressTicker() {
    if (progressInterval) clearInterval(progressInterval);
    progressInterval = setInterval(() => {
      if (!currentTrackId) return;
      const elapsed = calculateElapsedSeconds();
      currentElapsedSec = elapsed;

      timeCurrent.textContent = formatTime(elapsed);

      // Duration: if livestream or unknown, total is stream
      if (trackDuration && trackDuration > 0) {
        timeTotal.textContent = formatTime(trackDuration);
        const percent = Math.min(100, Math.max(0, (elapsed / trackDuration) * 100));
        progressBar.style.width = `${percent}%`;
      } else {
        timeTotal.textContent = 'LIVE';
        progressBar.style.width = '100%';
      }
    }, 250);
  }

  // ==========================================
  // ANTI-ABUSE RATE LIMIT VISUALS
  // ==========================================

  function handleRateLimitError(message, remainingSeconds) {
    showToast('Rate Limit Exceeded', message, 'warning');
    startCooldownCountdown(remainingSeconds);
  }

  function startCooldownCountdown(seconds) {
    if (rateLimitCooldownTimer) clearInterval(rateLimitCooldownTimer);
    cooldownRemaining = seconds;

    rateLimitPill.classList.remove('hidden');
    rateLimitCounterBox.className = 'rate-limit-badge cooldown';

    function update() {
      if (cooldownRemaining <= 0) {
        clearInterval(rateLimitCooldownTimer);
        rateLimitPill.classList.add('hidden');
        rateLimitCounterBox.className = 'rate-limit-badge';
        rateLimitCounterText.textContent = '2 / 2 changes left (60s window)';
        return;
      }
      rateLimitPillText.textContent = `Cooldown: ${cooldownRemaining}s`;
      rateLimitCounterText.textContent = `Locked (${cooldownRemaining}s remaining)`;
      cooldownRemaining--;
    }

    update();
    rateLimitCooldownTimer = setInterval(update, 1000);
  }

  function updateRateLimitRemaining(remaining) {
    remainingChangesInWindow = remaining;
    if (cooldownRemaining <= 0) {
      rateLimitCounterText.textContent = `${remaining} / 2 changes left (60s window)`;
    }
  }

  // ==========================================
  // SOCKET.IO REAL-TIME EVENT HANDLERS
  // ==========================================

  function initSocket() {
    if (socket) return;

    socket = window.io();

    // 1. Room Joined
    socket.on('room_joined', (data) => {
      currentRoom = data.roomName;
      userRole = data.role;

      // Update Header
      displayRoomName.textContent = data.roomName;
      roleText.textContent = userRole === 'admin' ? 'Admin Host' : 'Guest Listener';
      roleBadge.className = `role-badge ${userRole}`;
      displayListenerCount.textContent = data.listenersCount || '1';

      if (userRole === 'admin') {
        btnClearQueue.classList.remove('hidden');
        if (btnDeleteRoom) btnDeleteRoom.classList.remove('hidden');
      } else {
        btnClearQueue.classList.add('hidden');
        if (btnDeleteRoom) btnDeleteRoom.classList.add('hidden');
      }

      // Hide Lobby, Show Dashboard
      lobbyScreen.classList.add('hidden');
      roomDashboard.classList.remove('hidden');

      // Update Track & Sync
      applyRoomTrackData(data);
      renderUsers(data.users);
      renderQueue(data.playlist);

      showToast('Connected', data.message, 'success');
      addActivity(`Connected as ${userRole.toUpperCase()}.`, 'system');

      startProgressTicker();
    });

    // 2. Periodic Server Heartbeat (every 10s)
    socket.on('sync_heartbeat', (data) => {
      if (data.currentVideoId !== currentTrackId) {
        // Video changed on server
        currentTrackId = data.currentVideoId;
        if (isPlayerReady && ytPlayer) {
          ytPlayer.loadVideoById({
            videoId: currentTrackId,
            startSeconds: data.elapsedSeconds,
          });
        }
      }

      isPlaying = data.isPlaying;
      currentElapsedSec = data.elapsedSeconds;
      startedAt = Date.now() - data.elapsedSeconds * 1000;

      syncPlayerToRoom(Boolean(data.isManualResync));
    });

    // 3. Room Track Updated (Broadcast to all clients simultaneously)
    socket.on('room_track_updated', (data) => {
      applyRoomTrackData(data);
      addActivity(`Track changed by ${data.changedBy}: "${data.currentTitle}"`, 'track');
    });

    // 4. Playback State Changed (Play/Pause)
    socket.on('playback_state_changed', (data) => {
      isPlaying = data.isPlaying;
      currentElapsedSec = data.elapsedSeconds;
      startedAt = Date.now() - data.elapsedSeconds * 1000;

      if (isPlayerReady && ytPlayer) {
        if (isPlaying) {
          ytPlayer.seekTo(data.elapsedSeconds, true);
          ytPlayer.playVideo();
        } else {
          ytPlayer.pauseVideo();
        }
      }
    });

    // 5. Seek Updated
    socket.on('seek_updated', (data) => {
      currentElapsedSec = data.elapsedSeconds;
      startedAt = Date.now() - data.elapsedSeconds * 1000;
      if (isPlayerReady && ytPlayer) {
        ytPlayer.seekTo(data.elapsedSeconds, true);
      }
      addActivity(`${data.seekBy} scrubbed to ${formatTime(data.elapsedSeconds)}`, 'control');
    });

    // 6. Playlist / Queue Updated
    socket.on('playlist_updated', (data) => {
      renderQueue(data.playlist);
    });

    // 7. Users Updated
    socket.on('user_joined', (data) => {
      displayListenerCount.textContent = data.listenersCount;
      renderUsers(data.users);
      addActivity(`${data.newUser} joined the room.`, 'user');
    });

    socket.on('user_left', (data) => {
      displayListenerCount.textContent = data.listenersCount;
      renderUsers(data.users);
      addActivity(`${data.leftUser} left the room.`, 'system');
    });

    socket.on('role_changed', (data) => {
      userRole = data.role;
      roleText.textContent = userRole === 'admin' ? 'Admin Host' : 'Guest Listener';
      roleBadge.className = `role-badge ${userRole}`;
      if (userRole === 'admin') {
        btnClearQueue.classList.remove('hidden');
        if (btnDeleteRoom) btnDeleteRoom.classList.remove('hidden');
        showToast('Admin Role Granted', 'You are now the Admin of this room.', 'success');
      } else {
        if (btnDeleteRoom) btnDeleteRoom.classList.add('hidden');
      }
    });

    // 8. Anti-Abuse Rate Limit & Error Handling
    socket.on('rate_limit_error', (data) => {
      handleRateLimitError(data.message, data.remainingSeconds);
    });

    socket.on('rate_limit_status', (data) => {
      updateRateLimitRemaining(data.remainingChanges);
    });

    socket.on('room_exists_error', (data) => {
      showToastWithAction(
        'Room Already Exists',
        data.message,
        'Delete Previous & Create',
        () => {
          primeAudioContext();
          const roomName = document.getElementById('create-room-name').value.trim();
          const password = document.getElementById('create-room-password').value.trim();
          const nickname = document.getElementById('create-nickname').value.trim();
          socket.emit('create_room', {
            roomName,
            password,
            nickname,
            forceRecreate: true,
          });
        }
      );
    });

    socket.on('active_rooms_list', (roomsList) => {
      renderActiveRoomsList(roomsList);
    });

    socket.on('room_not_found', (data) => {
      if (data.suggestions && data.suggestions.length > 0) {
        const bestMatch = data.suggestions[0];
        showToastWithAction(
          'Room Not Found',
          `Room "${data.requestedRoom}" does not exist. Did you mean "${bestMatch}"?`,
          `Join "${bestMatch}"`,
          () => {
            const pass = document.getElementById('join-room-password').value.trim();
            const nick = document.getElementById('join-nickname').value.trim();
            document.getElementById('join-room-name').value = bestMatch;
            socket.emit('join_room', { roomName: bestMatch, password: pass, nickname: nick });
          }
        );
      } else if (data.availableRooms && data.availableRooms.length > 0) {
        showToast('Room Not Found', `Room "${data.requestedRoom}" not found. Open rooms: ${data.availableRooms.join(', ')}`, 'warning');
      } else {
        showToast('No Active Rooms', `No rooms are currently open on this server. Please create a room to start listening!`, 'warning');
      }
    });

    socket.on('room_deleted', (data) => {
      showToast('Room Closed', data.message || 'Room was deleted by the Admin.', 'warning');
      leaveRoomState();
    });

    socket.on('error_notification', (data) => {
      showToast('Notice', data.message, 'error');
    });

    socket.on('room_activity', (data) => {
      addActivity(data.text, data.type);
    });

    socket.on('chat_message', (data) => {
      addActivity(data.text, 'chat', data.sender);
    });

    socket.on('disconnect', () => {
      syncStatusPill.className = 'sync-pill drifted';
      syncStatusText.textContent = 'Disconnected';
      showToast('Connection Lost', 'Disconnected from SyncBeat server. Reconnecting...', 'warning');
    });
  }

  function applyRoomTrackData(data) {
    currentTrackId = data.currentVideoId;
    currentTrackTitle.textContent = data.currentTitle || 'Unknown Title';
    currentTrackAuthor.textContent = data.currentAuthor || 'YouTube Artist';
    currentTrackThumb.src = data.currentThumbnail || `https://img.youtube.com/vi/${data.currentVideoId}/hqdefault.jpg`;
    trackDuration = data.duration || 210;
    isPlaying = data.isPlaying;

    currentElapsedSec = data.elapsedSeconds || 0;
    startedAt = data.startedAt || Date.now() - currentElapsedSec * 1000;

    timeTotal.textContent = formatTime(trackDuration);

    if (isPlayerReady && ytPlayer && currentTrackId) {
      const currentLoadedId = ytPlayer.getVideoData ? ytPlayer.getVideoData().video_id : null;
      if (currentLoadedId !== currentTrackId) {
        try {
          ytPlayer.loadVideoById({
            videoId: currentTrackId,
            startSeconds: currentElapsedSec,
          });
        } catch (e) {}
      } else {
        try {
          ytPlayer.seekTo(currentElapsedSec, true);
        } catch (e) {}
      }

      if (isPlaying) {
        try {
          if (audioUnlocked) {
            ytPlayer.unMute();
            ytPlayer.setVolume(parseInt(volumeSlider.value, 10) || 85);
          }
          ytPlayer.playVideo();
        } catch (e) {}
      } else {
        try {
          ytPlayer.pauseVideo();
        } catch (e) {}
      }
    } else if (!ytPlayer && window.YT && window.YT.Player && currentTrackId) {
      initYouTubePlayer(currentTrackId);
    }

    if (data.playlist) {
      renderQueue(data.playlist);
    }
  }

  function renderQueue(playlist) {
    if (!playlist || playlist.length === 0) {
      queueList.innerHTML = `
        <div class="empty-state">
          <p>Queue is empty</p>
          <span>Add tracks using the link input above</span>
        </div>
      `;
      queueCountBadge.textContent = '0 tracks';
      return;
    }

    queueCountBadge.textContent = `${playlist.length} track${playlist.length === 1 ? '' : 's'}`;
    queueList.innerHTML = '';

    playlist.forEach((item, index) => {
      const el = document.createElement('div');
      el.className = 'queue-item';
      el.innerHTML = `
        <img src="${item.thumbnailUrl}" class="queue-item-thumb" alt="Thumbnail">
        <div class="queue-item-info">
          <div class="queue-item-title" title="${item.title}">#${index + 1}. ${item.title}</div>
          <div class="queue-item-sub">Added by ${item.addedBy}</div>
        </div>
        ${userRole === 'admin' ? `<button class="btn-remove-queue" data-id="${item.id}" title="Remove track">&times;</button>` : ''}
      `;

      if (userRole === 'admin') {
        el.querySelector('.btn-remove-queue').addEventListener('click', () => {
          socket.emit('remove_queue_item', { itemId: item.id });
        });
      }

      queueList.appendChild(el);
    });
  }

  function renderUsers(users) {
    if (!users) return;
    usersList.innerHTML = '';
    users.forEach((u) => {
      const tag = document.createElement('div');
      tag.className = `user-tag ${u.role}`;
      tag.innerHTML = `
        <span class="user-dot"></span>
        <span>${u.nickname}</span>
        ${u.role === 'admin' ? '<span title="Admin">👑</span>' : ''}
      `;
      usersList.appendChild(tag);
    });
  }

  // ==========================================
  // EVENT LISTENERS & UI INTERACTIONS
  // ==========================================

  // Live Active Rooms loader
  const activeRoomsList = document.getElementById('active-rooms-list');
  const btnRefreshRooms = document.getElementById('btn-refresh-rooms');

  function renderActiveRoomsList(rooms) {
    if (!activeRoomsList) return;
    const countPill = document.getElementById('active-rooms-count-pill');
    if (countPill) {
      countPill.textContent = `${rooms ? rooms.length : 0} open`;
    }

    if (!rooms || rooms.length === 0) {
      activeRoomsList.innerHTML = `
        <div class="empty-rooms-box">
          <span>No rooms open on this server yet. Enter a room name below to start listening!</span>
        </div>
      `;
      return;
    }

    activeRoomsList.innerHTML = '';
    rooms.forEach((r) => {
      const card = document.createElement('div');
      card.className = 'room-card';

      const thumb = r.currentThumbnail || `https://img.youtube.com/vi/${r.currentVideoId || 'jfKfPfyJRdk'}/hqdefault.jpg`;
      const title = r.currentTitle || 'Live Music Stream';
      const listeners = r.listenersCount !== undefined ? r.listenersCount : 0;

      card.innerHTML = `
        <div class="room-card-thumb-wrap">
          <img src="${thumb}" alt="${r.name}" class="room-card-thumb" onerror="this.src='https://img.youtube.com/vi/jfKfPfyJRdk/hqdefault.jpg'">
          <span class="room-card-playing-badge">
            <span class="live-dot-mini"></span>
            LIVE
          </span>
        </div>
        <div class="room-card-info">
          <div class="room-card-name-row">
            <strong class="room-card-name">🎵 ${r.name}</strong>
            <span class="room-card-listeners">${listeners} 👤</span>
          </div>
          <p class="room-card-title" title="${title}">${title}</p>
        </div>
        <button type="button" class="room-card-join-btn" title="Join and listen to ${r.name}">
          <span>▶ Listen</span>
        </button>
      `;

      card.querySelector('.room-card-join-btn').addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        primeAudioContext();
        initSocket();
        const nickname = (document.getElementById('join-nickname') && document.getElementById('join-nickname').value.trim()) || '';
        showToast('Entering Room', `Joining "${r.name}"...`, 'info');
        socket.emit('join_room', { roomName: r.name, nickname });
      });

      card.addEventListener('click', () => {
        primeAudioContext();
        initSocket();
        const nickname = (document.getElementById('join-nickname') && document.getElementById('join-nickname').value.trim()) || '';
        showToast('Entering Room', `Joining "${r.name}"...`, 'info');
        socket.emit('join_room', { roomName: r.name, nickname });
      });

      activeRoomsList.appendChild(card);
    });
  }

  async function loadActiveRooms() {
    if (!activeRoomsList) return;
    try {
      const res = await fetch('/api/rooms');
      const data = await res.json();
      renderActiveRoomsList(data.rooms || []);
    } catch (e) {
      console.warn('loadActiveRooms network note:', e);
    }
  }

  if (btnRefreshRooms) {
    btnRefreshRooms.addEventListener('click', async (e) => {
      e.preventDefault();
      btnRefreshRooms.style.opacity = '0.5';
      await loadActiveRooms();
      setTimeout(() => {
        btnRefreshRooms.style.opacity = '1';
        showToast('Rooms Refreshed', 'Latest room list loaded from server.', 'success');
      }, 300);
    });
  }

  // Initial load of active rooms
  loadActiveRooms();

  // Background poller every 5 seconds while in lobby to ensure rooms never disappear
  setInterval(() => {
    if (!currentRoom) {
      loadActiveRooms();
    }
  }, 5000);

  // Tab switching
  tabJoin.addEventListener('click', () => {
    tabJoin.classList.add('active');
    tabJoin.setAttribute('aria-selected', 'true');
    tabCreate.classList.remove('active');
    tabCreate.setAttribute('aria-selected', 'false');
    joinForm.classList.remove('hidden');
    createForm.classList.add('hidden');
    loadActiveRooms();
  });

  tabCreate.addEventListener('click', () => {
    tabCreate.classList.add('active');
    tabCreate.setAttribute('aria-selected', 'true');
    tabJoin.classList.remove('active');
    tabJoin.setAttribute('aria-selected', 'false');
    createForm.classList.remove('hidden');
    joinForm.classList.add('hidden');
  });

  // JOIN ROOM SUBMIT (Requirement: counts as user interaction for audio unlock)
  joinForm.addEventListener('submit', (e) => {
    e.preventDefault();
    primeAudioContext();

    const roomName = document.getElementById('join-room-name').value.trim();
    const nickname = document.getElementById('join-nickname').value.trim();

    if (!roomName) {
      showToast('Validation Error', 'Please enter a room name.', 'error');
      return;
    }

    initSocket();
    socket.emit('join_room', { roomName, nickname });
  });

  // CREATE ROOM SUBMIT (Admin creation & audio unlock)
  createForm.addEventListener('submit', (e) => {
    e.preventDefault();
    primeAudioContext();

    const roomName = document.getElementById('create-room-name').value.trim();
    const nickname = document.getElementById('create-nickname').value.trim();

    if (!roomName) {
      showToast('Validation Error', 'Please enter a room name.', 'error');
      return;
    }

    initSocket();
    socket.emit('create_room', { roomName, nickname });
  });

  // QUICK DEMO BUTTON (1-Click instant test)
  btnDemoStart.addEventListener('click', () => {
    primeAudioContext();
    initSocket();
    socket.emit('create_room', {
      roomName: 'vibes',
      nickname: 'DJ Host',
    });
  });

  // PLAY / PAUSE TOGGLE
  btnTogglePlay.addEventListener('click', () => {
    if (!socket) return;
    socket.emit('toggle_playback');
  });

  // SKIP TRACK (Subject to rate limits & lockout)
  btnSkipTrack.addEventListener('click', () => {
    if (!socket) return;
    socket.emit('change_track', { isSkip: true });
  });

  // FORCE MANUAL RESYNC
  btnForceResync.addEventListener('click', () => {
    if (!socket) return;
    socket.emit('request_resync');
  });

  // SCRUBBING PROGRESS BAR (Admin can seek room)
  progressContainer.addEventListener('click', (e) => {
    if (!socket || !trackDuration) return;
    const rect = progressContainer.getBoundingClientRect();
    const clickX = e.clientX - rect.left;
    const ratio = Math.max(0, Math.min(1, clickX / rect.width));
    const targetSeconds = Math.floor(ratio * trackDuration);

    socket.emit('seek_to', { targetSeconds });
  });

  // VOLUME & MUTE
  volumeSlider.addEventListener('input', (e) => {
    const val = parseInt(e.target.value, 10);
    volumeLabel.textContent = `${val}%`;
    if (ytPlayer && typeof ytPlayer.setVolume === 'function') {
      ytPlayer.unMute();
      ytPlayer.setVolume(val);
      iconVolumeHigh.classList.remove('hidden');
      iconVolumeMuted.classList.add('hidden');
    }
  });

  btnMute.addEventListener('click', () => {
    if (!ytPlayer) return;
    if (ytPlayer.isMuted()) {
      ytPlayer.unMute();
      iconVolumeHigh.classList.remove('hidden');
      iconVolumeMuted.classList.add('hidden');
      volumeSlider.value = ytPlayer.getVolume() || 75;
      volumeLabel.textContent = `${volumeSlider.value}%`;
    } else {
      ytPlayer.mute();
      iconVolumeHigh.classList.add('hidden');
      iconVolumeMuted.classList.remove('hidden');
      volumeLabel.textContent = '0%';
    }
  });

  // CHANGE TRACK IMMEDIATELY ("Play Now")
  btnPlayNow.addEventListener('click', () => {
    const url = inputYoutubeUrl.value.trim();
    if (!url) {
      showToast('Input Required', 'Please paste a YouTube URL or video ID.', 'warning');
      return;
    }
    if (!socket) return;
    socket.emit('change_track', { youtubeInput: url, isSkip: false });
    inputYoutubeUrl.value = '';
  });

  // ADD TRACK TO QUEUE
  btnAddQueue.addEventListener('click', () => {
    const url = inputYoutubeUrl.value.trim();
    if (!url) {
      showToast('Input Required', 'Please paste a YouTube URL or video ID.', 'warning');
      return;
    }
    if (!socket) return;
    socket.emit('add_to_queue', { youtubeInput: url });
    inputYoutubeUrl.value = '';
    showToast('Queued', 'Track added to room queue.', 'success');
  });

  // 1-CLICK PRESETS
  document.querySelectorAll('.chip-preset').forEach((chip) => {
    chip.addEventListener('click', () => {
      const videoId = chip.getAttribute('data-id');
      if (!socket) return;
      socket.emit('change_track', { youtubeInput: videoId, isSkip: false });
    });
  });

  // CLEAR QUEUE (Admin)
  btnClearQueue.addEventListener('click', () => {
    if (!socket) return;
    // Remove all items
    renderQueue([]);
    showToast('Queue Cleared', 'Upcoming tracks cleared.', 'success');
  });

  // CHAT / QUICK REACTION
  chatForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const text = chatInput.value.trim();
    if (!text || !socket) return;
    socket.emit('send_chat', { message: text });
    chatInput.value = '';
  });

  function leaveRoomState() {
    if (socket) {
      socket.disconnect();
      socket = null;
    }
    if (ytPlayer && typeof ytPlayer.stopVideo === 'function') {
      try {
        ytPlayer.stopVideo();
      } catch (e) {}
    }
    if (progressInterval) clearInterval(progressInterval);
    if (rateLimitCooldownTimer) clearInterval(rateLimitCooldownTimer);

    currentRoom = null;
    lobbyScreen.classList.remove('hidden');
  }

  // LEAVE ROOM
  btnLeaveRoom.addEventListener('click', () => {
    leaveRoomState();
    showToast('Left Room', 'You returned to the room lobby.', 'success');
  });

  // DELETE ROOM (Admin)
  if (btnDeleteRoom) {
    btnDeleteRoom.addEventListener('click', () => {
      if (!socket || userRole !== 'admin') return;
      if (confirm('Delete and close this room for all connected listeners?')) {
        socket.emit('delete_room');
        leaveRoomState();
        showToast('Room Deleted', 'The room was deleted and closed.', 'success');
      }
    });
  }

  // SHARE LINK BUTTON
  const btnShareLink = document.getElementById('btn-share-link');
  if (btnShareLink) {
    btnShareLink.addEventListener('click', async () => {
      if (!currentRoom) return;
      const shareUrl = `${window.location.origin}/?room=${encodeURIComponent(currentRoom)}`;
      try {
        await navigator.clipboard.writeText(shareUrl);
        showToast('Link Copied!', `Invite link for "${currentRoom}" copied! Anyone with this link can enter directly.`, 'success');
      } catch (err) {
        prompt('Copy this link to invite friends:', shareUrl);
      }
    });
  }

  // URL Query Param Auto-Detection (?room=...)
  const urlParams = new URLSearchParams(window.location.search);
  const roomParam = urlParams.get('room');
  if (roomParam) {
    const inputJoin = document.getElementById('join-room-name');
    if (inputJoin) {
      inputJoin.value = roomParam;
    }
    showToast('Direct Invite Link', `Room "${roomParam}" detected from link! Click "Join Room" to enter with 1 click.`, 'info');
  }

  const serverHostText = document.getElementById('server-host-text');
  if (serverHostText) {
    serverHostText.textContent = `Server: ${window.location.host}`;
  }

  // Pre-initialize socket connection so lobby receives real-time room updates immediately
  initSocket();

  // Auto-detect if browser autoplay was blocked
  setTimeout(() => {
    if (!audioUnlocked && currentRoom) {
      audioUnlockBanner.classList.remove('hidden');
    }
  }, 2000);
})();
