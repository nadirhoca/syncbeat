/**
 * SyncBeat Main Client SPA Application Controller
 * Handles YouTube IFrame API lifecycle, Socket.io events, Lobby / Room navigation,
 * Anti-Abuse cooldown timers, sidebar panels, and interactive controls.
 */

window.SyncBeatApp = (function () {
  let socket = null;
  let ytPlayer = null;
  let currentRoom = null;
  let currentRole = 'client'; // 'admin' | 'client'
  let currentUser = null;
  let cooldownInterval = null;
  let pendingSyncState = null;
  let activeTab = 'queue'; // 'queue' | 'listeners' | 'chat'

  // Quick Preset Music Streams
  const PRESETS = [
    { name: '🎧 Lofi Chill', id: 'jfKfPfyJRdk' },
    { name: '🌆 Synthwave', id: '4xDzrJKXOOY' },
    { name: '☕ Cafe Jazz', id: 'Dx5qFachd3A' },
    { name: '⚡ Cyberpunk', id: '5qap5aO4i9A' },
    { name: '🌿 Ambient Focus', id: 'DWcJFNfaw90' }
  ];

  function init() {
    initSocket();
    initYouTubeApi();
    setupDomListeners();
    renderPresets();

    // Initialize Audio Unlock resilience handler
    window.SyncBeatAudioUnlock.init('audio-unlock-banner', () => {
      unmuteAndSetVolume();
    });

    // Check for direct room invite link query param: ?room=<name>
    const urlParams = new URLSearchParams(window.location.search);
    const roomParam = urlParams.get('room');
    if (roomParam) {
      const storedNick = localStorage.getItem('syncbeat_nickname') || 'Guest';
      setTimeout(() => {
        joinRoom(roomParam, storedNick);
      }, 350);
    }
  }

  function unmuteAndSetVolume() {
    if (ytPlayer) {
      try {
        if (typeof ytPlayer.unMute === 'function') {
          ytPlayer.unMute();
        }
        const storedVol = Number(localStorage.getItem('syncbeat_volume')) || 80;
        if (typeof ytPlayer.setVolume === 'function') {
          ytPlayer.setVolume(storedVol);
        }
      } catch (e) {
        console.warn('[SyncBeat] Unmute attempt warning:', e);
      }
    }
  }

  // Socket.io Connection & Listeners
  function initSocket() {
    socket = io();

    socket.on('connect', () => {
      console.log('[SyncBeat] Socket connected:', socket.id);
      updateConnectionStatus(true);
    });

    socket.on('disconnect', () => {
      console.warn('[SyncBeat] Socket disconnected');
      updateConnectionStatus(false);
    });

    socket.on('room:joined', ({ syncState, you, cooldownRemainingSec }) => {
      currentUser = you;
      currentRole = you.role;
      currentRoom = syncState;

      // Update URL query without full reload
      const newUrl = `${window.location.pathname}?room=${encodeURIComponent(syncState.normalizedName)}`;
      window.history.pushState({ room: syncState.normalizedName }, '', newUrl);

      showRoomView(syncState);
      applyRoomState(syncState);

      if (cooldownRemainingSec > 0) {
        startCooldownTimer(cooldownRemainingSec);
      }

      showToast(`Joined ${syncState.name} as ${you.role === 'admin' ? '👑 Admin' : 'Listener'}!`, 'success');
    });

    socket.on('room:sync', (syncState) => {
      currentRoom = syncState;
      applyRoomState(syncState);
    });

    socket.on('listeners:update', ({ listeners }) => {
      renderListeners(listeners);
      updateListenerBadges(listeners.length);
    });

    socket.on('queue:update', ({ queue }) => {
      if (currentRoom) currentRoom.queue = queue;
      renderQueue(queue);
    });

    socket.on('activity:feed', (activity) => {
      appendFeedItem(activity);
    });

    socket.on('chat:message', (message) => {
      appendChatMessage(message);
    });

    socket.on('role:promoted', ({ role }) => {
      currentRole = role;
      if (currentUser) currentUser.role = role;
      updateAdminControlsVisibility();
      showToast('👑 You are now the Room Admin! You have playback authority.', 'info');
    });

    // Anti-Abuse Rate Limit feedback
    socket.on('rate:limit_error', ({ message, cooldownRemainingSec }) => {
      startCooldownTimer(cooldownRemainingSec);
      showToast(message, 'warning');
    });

    socket.on('action:error', ({ message }) => {
      showToast(message, 'error');
    });

    socket.on('lobby:rooms_update', ({ rooms }) => {
      renderLobbyRooms(rooms);
    });
  }

  // YouTube IFrame Player Setup
  function initYouTubeApi() {
    window.onYouTubeIframeAPIReady = () => {
      ytPlayer = new YT.Player('yt-player-target', {
        height: '100%',
        width: '100%',
        videoId: (currentRoom && currentRoom.currentVideoId) || 'jfKfPfyJRdk',
        playerVars: {
          autoplay: 1,
          mute: 1, // Start muted initially to guarantee compliance with browser autoplay policy!
          controls: 1, // Show standard controls for resilience
          disablekb: 0,
          fs: 1,
          rel: 0,
          modestbranding: 1,
          playsinline: 1,
          enablejsapi: 1
        },
        events: {
          onReady: onPlayerReady,
          onStateChange: onPlayerStateChange,
          onError: onPlayerError
        }
      });
    };

    // Load YouTube IFrame API script tag dynamically if not loaded
    if (!window.YT) {
      const tag = document.createElement('script');
      tag.src = 'https://www.youtube.com/iframe_api';
      const firstScriptTag = document.getElementsByTagName('script')[0];
      firstScriptTag.parentNode.insertBefore(tag, firstScriptTag);
    }
  }

  function onPlayerReady(event) {
    console.log('[SyncBeat] YouTube player ready');
    window.SyncBeatEngine.init(ytPlayer);

    const storedVol = Number(localStorage.getItem('syncbeat_volume')) || 80;
    const volInput = document.getElementById('volume-slider');
    if (volInput) volInput.value = storedVol;

    // If audio is already unlocked by user gesture, unmute now!
    if (window.SyncBeatAudioUnlock.isUnlocked()) {
      unmuteAndSetVolume();
    } else {
      window.SyncBeatAudioUnlock.showBanner();
    }

    if (pendingSyncState) {
      window.SyncBeatEngine.applyServerState(pendingSyncState);
      pendingSyncState = null;
    }
  }

  function onPlayerStateChange(event) {
    // 0 = ENDED
    if (event.data === YT.PlayerState.ENDED) {
      console.log('[SyncBeat] Video ended, advancing track');
      if (currentRole === 'admin') {
        socket.emit('playback:skip');
      }
    } else if (event.data === YT.PlayerState.PLAYING) {
      // If user interacted with the player directly, unlock audio
      if (!window.SyncBeatAudioUnlock.isUnlocked()) {
        window.SyncBeatAudioUnlock.triggerUnlock();
      }
    }
  }

  function onPlayerError(event) {
    console.error('[SyncBeat] YouTube player error code:', event.data);
    // Don't auto-skip aggressively on transient errors (like 150/101 during network hiccups)
    showToast('YouTube stream connection warning. Retrying...', 'warning');
  }

  // Update room state when server emits authoritative payload
  function applyRoomState(syncState) {
    if (!ytPlayer || typeof ytPlayer.loadVideoById !== 'function') {
      pendingSyncState = syncState;
    } else {
      window.SyncBeatEngine.applyServerState(syncState);
    }

    // Update Now Playing UI Card
    const titleEl = document.getElementById('now-playing-title');
    const authorEl = document.getElementById('now-playing-author');
    const thumbEl = document.getElementById('now-playing-thumb');
    const roomTitleEl = document.getElementById('room-header-name');
    const eqEl = document.getElementById('equalizer-container');

    if (titleEl) titleEl.textContent = syncState.currentTitle || 'Unknown Track';
    if (authorEl) authorEl.textContent = syncState.currentAuthor || 'SyncBeat Stream';
    if (thumbEl) {
      thumbEl.src = syncState.currentThumbnail || `https://img.youtube.com/vi/${syncState.currentVideoId}/hqdefault.jpg`;
      thumbEl.alt = syncState.currentTitle;
    }
    if (roomTitleEl) roomTitleEl.textContent = syncState.name;

    // Equalizer pulsing animation toggle
    if (eqEl) {
      if (syncState.isPlaying) {
        eqEl.classList.remove('equalizer-paused');
        eqEl.classList.add('equalizer-playing');
      } else {
        eqEl.classList.remove('equalizer-playing');
        eqEl.classList.add('equalizer-paused');
      }
    }

    // Play/Pause button icon state
    updatePlayPauseButton(syncState.isPlaying);

    // Queue & Listeners update
    if (syncState.queue) renderQueue(syncState.queue);
    if (syncState.listeners) renderListeners(syncState.listeners);

    updateAdminControlsVisibility();
  }

  // Update Play/Pause Button Visual
  function updatePlayPauseButton(isPlaying) {
    const btn = document.getElementById('btn-play-pause');
    if (!btn) return;
    if (isPlaying) {
      btn.innerHTML = `
        <svg class="w-6 h-6 text-white" fill="currentColor" viewBox="0 0 24 24"><path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/></svg>
      `;
      btn.title = 'Pause Playback (Admin)';
    } else {
      btn.innerHTML = `
        <svg class="w-6 h-6 text-white ml-0.5" fill="currentColor" viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>
      `;
      btn.title = 'Resume Playback (Admin)';
    }
  }

  // Sync Engine Tick Hook (Updates Scrubber & Clocks)
  window.SyncBeatEngine.onTick(({ currentTime, duration, isPlaying }) => {
    const elapsedEl = document.getElementById('time-elapsed');
    const totalEl = document.getElementById('time-total');
    const progressEl = document.getElementById('progress-bar');
    const scrubberEl = document.getElementById('scrubber-range');

    if (elapsedEl) elapsedEl.textContent = formatTime(currentTime);

    if (duration > 0) {
      if (totalEl) totalEl.textContent = formatTime(duration);
      const percent = Math.min(100, Math.max(0, (currentTime / duration) * 100));
      if (progressEl) progressEl.style.width = `${percent}%`;
      if (scrubberEl && !scrubberEl.matches(':active')) {
        scrubberEl.value = percent;
      }
    } else {
      // Live streams
      if (totalEl) totalEl.textContent = 'LIVE';
      if (progressEl) progressEl.style.width = '100%';
    }
  });

  // Anti-Abuse Countdown Timer Handler
  function startCooldownTimer(seconds) {
    if (cooldownInterval) clearInterval(cooldownInterval);

    const badge = document.getElementById('cooldown-badge');
    const countdownEl = document.getElementById('cooldown-seconds');
    const adminActionButtons = document.querySelectorAll('.rate-limited-action');

    let rem = seconds;

    const setCooldownState = (active) => {
      if (active) {
        if (badge) badge.classList.remove('hidden');
        adminActionButtons.forEach(btn => {
          btn.setAttribute('disabled', 'true');
          btn.classList.add('opacity-40', 'cursor-not-allowed');
        });
      } else {
        if (badge) badge.classList.add('hidden');
        adminActionButtons.forEach(btn => {
          btn.removeAttribute('disabled');
          btn.classList.remove('opacity-40', 'cursor-not-allowed');
        });
      }
    };

    setCooldownState(true);
    if (countdownEl) countdownEl.textContent = `${rem}s`;

    cooldownInterval = setInterval(() => {
      rem -= 1;
      if (countdownEl) countdownEl.textContent = `${rem}s`;
      if (rem <= 0) {
        clearInterval(cooldownInterval);
        setCooldownState(false);
      }
    }, 1000);
  }

  // UI Event Listeners
  function setupDomListeners() {
    // Lobby Quick Join / Create Form
    const joinForm = document.getElementById('lobby-join-form');
    if (joinForm) {
      joinForm.addEventListener('submit', (e) => {
        e.preventDefault();
        window.SyncBeatAudioUnlock.triggerUnlock();
        unmuteAndSetVolume();

        const roomInput = document.getElementById('input-room-name');
        const nickInput = document.getElementById('input-nickname');
        const roomName = roomInput ? roomInput.value.trim() : '';
        const nickname = nickInput ? nickInput.value.trim() : 'Guest';
        if (roomName) {
          localStorage.setItem('syncbeat_nickname', nickname);
          joinRoom(roomName, nickname);
        }
      });
    }

    // Play/Pause button
    const btnPlayPause = document.getElementById('btn-play-pause');
    if (btnPlayPause) {
      btnPlayPause.addEventListener('click', () => {
        window.SyncBeatAudioUnlock.triggerUnlock();
        unmuteAndSetVolume();

        if (currentRole !== 'admin') {
          showToast('Only the room Admin can toggle playback.', 'warning');
          return;
        }
        const nextState = !window.SyncBeatEngine.isPlaying();
        socket.emit('playback:toggle', { isPlaying: nextState });
      });
    }

    // Skip Button
    const btnSkip = document.getElementById('btn-skip');
    if (btnSkip) {
      btnSkip.addEventListener('click', () => {
        window.SyncBeatAudioUnlock.triggerUnlock();
        unmuteAndSetVolume();

        if (currentRole !== 'admin') {
          showToast('Only the room Admin can skip tracks.', 'warning');
          return;
        }
        socket.emit('playback:skip');
      });
    }

    // Force Resync Button
    const btnResync = document.getElementById('btn-resync');
    if (btnResync) {
      btnResync.addEventListener('click', () => {
        window.SyncBeatAudioUnlock.triggerUnlock();
        unmuteAndSetVolume();
        window.SyncBeatEngine.forceResync();
        socket.emit('sync:request');
        showToast('Resynchronized with server stream.', 'info');
      });
    }

    // Volume Slider & Mute
    const volSlider = document.getElementById('volume-slider');
    const btnMute = document.getElementById('btn-mute');

    if (volSlider) {
      volSlider.addEventListener('input', (e) => {
        window.SyncBeatAudioUnlock.triggerUnlock();
        const val = Number(e.target.value);
        if (ytPlayer && ytPlayer.setVolume) {
          ytPlayer.setVolume(val);
          if (ytPlayer.isMuted && ytPlayer.isMuted() && val > 0) {
            ytPlayer.unMute();
          }
        }
        localStorage.setItem('syncbeat_volume', val);
        updateVolumeIcon(val === 0);
      });
    }

    if (btnMute) {
      btnMute.addEventListener('click', () => {
        window.SyncBeatAudioUnlock.triggerUnlock();
        if (!ytPlayer) return;
        const isMuted = ytPlayer.isMuted && ytPlayer.isMuted();
        if (isMuted) {
          ytPlayer.unMute();
          updateVolumeIcon(false);
        } else {
          ytPlayer.mute();
          updateVolumeIcon(true);
        }
      });
    }

    // Scrubber Range
    const scrubberRange = document.getElementById('scrubber-range');
    if (scrubberRange) {
      scrubberRange.addEventListener('mousedown', () => window.SyncBeatEngine.setIsSeeking(true));
      scrubberRange.addEventListener('touchstart', () => window.SyncBeatEngine.setIsSeeking(true));

      scrubberRange.addEventListener('change', (e) => {
        window.SyncBeatEngine.setIsSeeking(false);
        const percent = Number(e.target.value);
        const duration = window.SyncBeatEngine.getDuration();
        if (duration > 0) {
          const targetSec = (percent / 100) * duration;
          if (currentRole === 'admin') {
            socket.emit('playback:seek', { targetSec });
          } else {
            showToast('Only the room Admin can seek playback.', 'warning');
            window.SyncBeatEngine.forceResync();
          }
        }
      });
    }

    // Add Track Form (Play Now / Add to Queue)
    const btnPlayNow = document.getElementById('btn-play-now');
    const btnAddQueue = document.getElementById('btn-add-queue');
    const inputTrack = document.getElementById('input-track-url');

    if (btnPlayNow) {
      btnPlayNow.addEventListener('click', () => {
        const val = inputTrack ? inputTrack.value.trim() : '';
        if (!val) {
          showToast('Please enter a YouTube URL or 11-character video ID.', 'warning');
          return;
        }
        if (currentRole !== 'admin') {
          showToast('Only the room Admin can immediately play tracks. Try "Add to Queue"!', 'warning');
          return;
        }
        socket.emit('track:play_now', { input: val });
        if (inputTrack) inputTrack.value = '';
      });
    }

    if (btnAddQueue) {
      btnAddQueue.addEventListener('click', () => {
        const val = inputTrack ? inputTrack.value.trim() : '';
        if (!val) {
          showToast('Please enter a YouTube URL or 11-character video ID.', 'warning');
          return;
        }
        socket.emit('track:add_queue', { input: val });
        if (inputTrack) inputTrack.value = '';
      });
    }

    // Chat Form
    const chatForm = document.getElementById('chat-form');
    if (chatForm) {
      chatForm.addEventListener('submit', (e) => {
        e.preventDefault();
        const inputChat = document.getElementById('input-chat-message');
        const text = inputChat ? inputChat.value.trim() : '';
        if (text) {
          socket.emit('chat:send', { text });
          inputChat.value = '';
        }
      });
    }

    // Copy Invite Link Button
    const btnCopyInvite = document.getElementById('btn-copy-invite');
    const btnLobbyShare = document.getElementById('btn-lobby-share');

    const copyInviteAction = () => {
      const shareUrl = currentRoom
        ? `${window.location.origin}/?room=${encodeURIComponent(currentRoom.normalizedName)}`
        : window.location.href;

      navigator.clipboard.writeText(shareUrl).then(() => {
        showToast('Invite link copied to clipboard! Share it with friends.', 'success');
      }).catch(() => {
        prompt('Copy this invite URL:', shareUrl);
      });
    };

    if (btnCopyInvite) btnCopyInvite.addEventListener('click', copyInviteAction);
    if (btnLobbyShare) btnLobbyShare.addEventListener('click', copyInviteAction);

    // Leave Room / Back to Lobby Button
    const btnLeaveRoom = document.getElementById('btn-leave-room');
    if (btnLeaveRoom) {
      btnLeaveRoom.addEventListener('click', () => {
        window.location.href = '/';
      });
    }

    // Sidebar Tab Switching
    const tabs = ['queue', 'listeners', 'chat'];
    tabs.forEach(tab => {
      const tabBtn = document.getElementById(`tab-btn-${tab}`);
      if (tabBtn) {
        tabBtn.addEventListener('click', () => switchTab(tab));
      }
    });
  }

  function switchTab(tabName) {
    activeTab = tabName;
    ['queue', 'listeners', 'chat'].forEach(t => {
      const btn = document.getElementById(`tab-btn-${t}`);
      const panel = document.getElementById(`tab-panel-${t}`);
      if (btn && panel) {
        if (t === tabName) {
          btn.classList.add('border-violet-500', 'text-violet-400');
          btn.classList.remove('border-transparent', 'text-zinc-400');
          panel.classList.remove('hidden');
        } else {
          btn.classList.remove('border-violet-500', 'text-violet-400');
          btn.classList.add('border-transparent', 'text-zinc-400');
          panel.classList.add('hidden');
        }
      }
    });
  }

  function renderPresets() {
    const container = document.getElementById('preset-chips');
    if (!container) return;
    container.innerHTML = PRESETS.map(p => `
      <button type="button" onclick="window.SyncBeatApp.fillPreset('${p.id}')" class="rounded-lg border border-zinc-700/60 bg-zinc-800/50 px-2.5 py-1 text-xs font-medium text-zinc-300 transition-colors hover:border-violet-500/60 hover:bg-violet-600/10 hover:text-violet-200">
        ${p.name}
      </button>
    `).join('');
  }

  function fillPreset(videoId) {
    const input = document.getElementById('input-track-url');
    if (input) {
      input.value = videoId;
      input.focus();
    }
  }

  function joinRoom(roomName, nickname) {
    // Unlock audio context inside user click gesture
    window.SyncBeatAudioUnlock.triggerUnlock();
    unmuteAndSetVolume();

    const finalNick = nickname || localStorage.getItem('syncbeat_nickname') || 'Guest';
    socket.emit('join:room', { roomName, nickname: finalNick });
  }

  function showRoomView(syncState) {
    const lobbyView = document.getElementById('lobby-view');
    const roomView = document.getElementById('room-view');
    const inviteBtn = document.getElementById('btn-copy-invite');

    if (lobbyView) lobbyView.classList.add('hidden');
    if (roomView) roomView.classList.remove('hidden');
    if (inviteBtn) inviteBtn.classList.remove('hidden');

    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function renderQueue(queue) {
    const container = document.getElementById('queue-list');
    const countBadge = document.getElementById('queue-count-badge');
    if (countBadge) countBadge.textContent = queue.length;
    if (!container) return;

    if (!queue || queue.length === 0) {
      container.innerHTML = `
        <div class="p-6 text-center text-zinc-500">
          <svg class="mx-auto h-8 w-8 text-zinc-600 mb-2" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M9 19V6l12-3v13M9 19c0 1.105-1.343 2-3 2s-3-.895-3-2 1.343-2 3-2 3 .895 3 2zm12-3c0 1.105-1.343 2-3 2s-3-.895-3-2 1.343-2 3-2 3 .895 3 2zM9 10l12-3"></path></svg>
          <p class="text-sm font-medium">No tracks in queue.</p>
          <p class="text-xs text-zinc-600 mt-1">Paste a YouTube URL above to add songs!</p>
        </div>
      `;
      return;
    }

    container.innerHTML = queue.map((track, idx) => {
      const canRemove = currentRole === 'admin' || (currentUser && currentUser.nickname === track.addedBy);
      return `
        <div class="flex items-center justify-between gap-3 rounded-xl border border-zinc-800/60 bg-zinc-900/40 p-2.5 transition-colors hover:border-zinc-700/60 hover:bg-zinc-800/40">
          <div class="flex items-center gap-3 overflow-hidden">
            <span class="font-mono text-xs text-zinc-500 w-4 text-center">${idx + 1}</span>
            <img src="${track.thumbnailUrl}" alt="" class="h-10 w-14 rounded-lg object-cover bg-zinc-950 flex-shrink-0" />
            <div class="overflow-hidden">
              <p class="truncate text-xs font-semibold text-white">${escapeHtml(track.title)}</p>
              <p class="truncate text-[11px] text-zinc-400">${escapeHtml(track.author)} • <span class="text-violet-400 font-medium">added by ${escapeHtml(track.addedBy)}</span></p>
            </div>
          </div>
          ${canRemove ? `
            <button onclick="window.SyncBeatApp.removeQueueItem('${track.id}')" class="p-1.5 text-zinc-500 hover:text-rose-400 hover:bg-rose-500/10 rounded-lg transition-colors flex-shrink-0" title="Remove track">
              <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"></path></svg>
            </button>
          ` : ''}
        </div>
      `;
    }).join('');
  }

  function removeQueueItem(trackId) {
    socket.emit('queue:remove', { trackId });
  }

  function renderListeners(listeners) {
    const container = document.getElementById('listeners-list');
    const countBadge = document.getElementById('listeners-count-badge');
    if (countBadge) countBadge.textContent = listeners.length;
    if (!container) return;

    container.innerHTML = listeners.map(l => {
      const isYou = currentUser && currentUser.id === l.id;
      const isAdmin = l.role === 'admin';
      return `
        <div class="flex items-center justify-between rounded-xl border border-zinc-800/50 bg-zinc-900/30 px-3 py-2">
          <div class="flex items-center gap-2.5">
            <div class="flex h-7 w-7 items-center justify-center rounded-full bg-gradient-to-tr ${isAdmin ? 'from-amber-500 to-yellow-300 text-black' : 'from-violet-600 to-fuchsia-600 text-white'} text-xs font-bold shadow">
              ${l.nickname.slice(0, 1).toUpperCase()}
            </div>
            <div>
              <p class="text-xs font-semibold text-zinc-200">
                ${escapeHtml(l.nickname)} ${isYou ? '<span class="text-violet-400 font-mono text-[10px] ml-1">(You)</span>' : ''}
              </p>
              <p class="text-[10px] text-zinc-500">${isAdmin ? '👑 Room Admin' : 'Listener'}</p>
            </div>
          </div>
          <span class="inline-flex items-center gap-1 text-[10px] font-mono text-emerald-400 bg-emerald-500/10 px-2 py-0.5 rounded-full border border-emerald-500/20">
            <span class="h-1.5 w-1.5 rounded-full bg-emerald-400 animate-pulse"></span>
            Synced
          </span>
        </div>
      `;
    }).join('');
  }

  function updateListenerBadges(count) {
    document.querySelectorAll('.live-listener-count').forEach(el => {
      el.textContent = `${count} listener${count === 1 ? '' : 's'}`;
    });
  }

  function updateAdminControlsVisibility() {
    const adminBadges = document.querySelectorAll('.admin-only-badge');
    const adminControls = document.querySelectorAll('.admin-only-control');
    const isAdmin = currentRole === 'admin';

    adminBadges.forEach(el => {
      if (isAdmin) el.classList.remove('hidden');
      else el.classList.add('hidden');
    });

    adminControls.forEach(el => {
      if (isAdmin) {
        el.removeAttribute('disabled');
        el.classList.remove('opacity-50', 'cursor-not-allowed');
      } else {
        el.setAttribute('disabled', 'true');
        el.classList.add('opacity-50', 'cursor-not-allowed');
      }
    });
  }

  function appendChatMessage(msg) {
    const container = document.getElementById('chat-messages-container');
    if (!container) return;

    const isYou = currentUser && currentUser.id === msg.senderId;
    const isAdmin = msg.role === 'admin';
    const timeStr = new Date(msg.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

    const msgEl = document.createElement('div');
    msgEl.className = `flex flex-col ${isYou ? 'items-end' : 'items-start'} space-y-1`;
    msgEl.innerHTML = `
      <div class="flex items-center gap-1.5 text-[11px] text-zinc-400">
        <span class="font-semibold ${isAdmin ? 'text-amber-400' : 'text-zinc-300'}">${escapeHtml(msg.sender)}</span>
        ${isAdmin ? '<span class="text-[10px] text-amber-400 font-mono">👑</span>' : ''}
        <span class="text-[10px] text-zinc-600 font-mono">${timeStr}</span>
      </div>
      <div class="rounded-2xl px-3.5 py-2 text-xs max-w-[85%] break-words ${isYou ? 'bg-violet-600 text-white rounded-tr-none' : 'bg-zinc-800/80 text-zinc-200 border border-zinc-700/50 rounded-tl-none'}">
        ${escapeHtml(msg.text)}
      </div>
    `;

    container.appendChild(msgEl);
    container.scrollTop = container.scrollHeight;
  }

  function appendFeedItem(act) {
    const container = document.getElementById('chat-messages-container');
    if (!container) return;

    const timeStr = new Date(act.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const itemEl = document.createElement('div');
    itemEl.className = 'my-1 rounded-lg bg-zinc-900/60 border border-zinc-800/80 px-2.5 py-1.5 text-[11px] text-zinc-400 flex items-center justify-between gap-2';
    itemEl.innerHTML = `
      <span class="flex items-center gap-1.5">
        <span class="text-violet-400">⚡</span>
        <span>${escapeHtml(act.text)}</span>
      </span>
      <span class="font-mono text-[10px] text-zinc-600 flex-shrink-0">${timeStr}</span>
    `;

    container.appendChild(itemEl);
    container.scrollTop = container.scrollHeight;
  }

  function renderLobbyRooms(rooms) {
    const container = document.getElementById('lobby-rooms-container');
    if (!container) return;

    if (!rooms || rooms.length === 0) {
      container.innerHTML = `
        <div class="col-span-full p-8 text-center rounded-2xl border border-zinc-800/80 bg-zinc-900/40">
          <p class="text-zinc-400 font-medium">No active rooms found.</p>
        </div>
      `;
      return;
    }

    container.innerHTML = rooms.map(room => {
      const isLive = room.isPlaying;
      const count = room.listenerCount || 0;
      const safeNorm = encodeURIComponent(room.normalizedName);
      const thumb = room.currentThumbnail || `https://img.youtube.com/vi/${room.currentVideoId}/hqdefault.jpg`;

      return `
        <div class="room-card group relative flex flex-col justify-between overflow-hidden rounded-2xl border border-zinc-800/80 bg-zinc-900/50 p-4 transition-all duration-300 hover:border-violet-500/50 hover:bg-zinc-900/90 hover:shadow-xl hover:shadow-violet-950/20 backdrop-blur-sm" data-room="${safeNorm}">
          <div>
            <div class="relative aspect-video w-full overflow-hidden rounded-xl bg-zinc-950 border border-zinc-800/50">
              <img src="${thumb}" alt="${escapeHtml(room.currentTitle)}" class="h-full w-full object-cover transition-transform duration-500 group-hover:scale-105" loading="lazy" />
              <div class="absolute inset-0 bg-gradient-to-t from-black/80 via-transparent to-black/20"></div>
              
              <div class="absolute top-2.5 left-2.5 flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-semibold backdrop-blur-md ${isLive ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30' : 'bg-amber-500/20 text-amber-400 border border-amber-500/30'}">
                <span class="relative flex h-2 w-2">
                  ${isLive ? '<span class="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>' : ''}
                  <span class="relative inline-flex rounded-full h-2 w-2 ${isLive ? 'bg-emerald-500' : 'bg-amber-500'}"></span>
                </span>
                <span>${isLive ? 'LIVE' : 'PAUSED'}</span>
              </div>

              <div class="absolute top-2.5 right-2.5 flex items-center gap-1.5 rounded-full bg-black/60 px-2.5 py-1 text-xs font-medium text-zinc-300 backdrop-blur-md border border-white/10">
                <svg class="w-3.5 h-3.5 text-violet-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 4.354a4 4 0 110 5.292M15 21H3v-1a6 6 0 0112 0v1zm0 0h6v-1a6 6 0 00-9-5.197M13 7a4 4 0 11-8 0 4 4 0 018 0z"></path></svg>
                <span>${count} listener${count === 1 ? '' : 's'}</span>
              </div>

              <div class="absolute bottom-2.5 left-2.5 right-2.5">
                <p class="truncate text-sm font-semibold text-white drop-shadow">${escapeHtml(room.currentTitle)}</p>
                <p class="truncate text-xs text-zinc-300 drop-shadow">${escapeHtml(room.currentAuthor)}</p>
              </div>
            </div>

            <div class="mt-3.5 flex items-center justify-between">
              <h3 class="text-base font-bold text-white group-hover:text-violet-300 transition-colors">${escapeHtml(room.name)}</h3>
              <span class="text-xs text-zinc-400 font-mono">${room.queueCount || 0} in queue</span>
            </div>
          </div>

          <div class="mt-4 pt-3 border-t border-zinc-800/60">
            <button onclick="window.SyncBeatApp.joinRoom('${safeNorm}')" class="w-full flex items-center justify-center gap-2 rounded-xl bg-violet-600/20 py-2 text-sm font-semibold text-violet-300 border border-violet-500/30 transition-all hover:bg-violet-600 hover:text-white hover:border-violet-600 hover:shadow-lg hover:shadow-violet-600/25 active:scale-[0.98]">
              <svg class="w-4 h-4" fill="currentColor" viewBox="0 0 20 20"><path d="M6.3 2.841A1.5 1.5 0 004 4.11V15.89a1.5 1.5 0 002.3 1.269l9.344-5.89a1.5 1.5 0 000-2.538L6.3 2.84z"></path></svg>
              Tune In Now
            </button>
          </div>
        </div>
      `;
    }).join('');
  }

  function showDriftBadge(driftSec) {
    const badge = document.getElementById('drift-indicator');
    if (!badge) return;
    badge.textContent = `Syncing (${driftSec.toFixed(1)}s)`;
    badge.classList.remove('hidden');
    setTimeout(() => badge.classList.add('hidden'), 2500);
  }

  function notifyDuration(dur) {
    socket.emit('player:duration', { duration: dur });
  }

  function updateConnectionStatus(connected) {
    const el = document.getElementById('connection-status-dot');
    if (el) {
      if (connected) {
        el.className = 'h-2 w-2 rounded-full bg-emerald-500 ring-4 ring-emerald-500/20';
      } else {
        el.className = 'h-2 w-2 rounded-full bg-rose-500 ring-4 ring-rose-500/20 animate-ping';
      }
    }
  }

  function updateVolumeIcon(isMuted) {
    const icon = document.getElementById('volume-icon');
    if (!icon) return;
    if (isMuted) {
      icon.innerHTML = `<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5.586 15H4a1 1 0 01-1-1v-4a1 1 0 011-1h1.586l4.707-4.707C10.923 3.663 12 4.109 12 5v14c0 .891-1.077 1.337-1.707.707L5.586 15z" clip-rule="evenodd"/><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M17 14l2-2m0 0l2-2m-2 2l-2-2m2 2l2 2"/>`;
    } else {
      icon.innerHTML = `<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15.536 8.464a5 5 0 010 7.072m2.828-9.9a9 9 0 010 12.728M5.586 15H4a1 1 0 01-1-1v-4a1 1 0 011-1h1.586l4.707-4.707C10.923 3.663 12 4.109 12 5v14c0 .891-1.077 1.337-1.707.707L5.586 15z"/>`;
    }
  }

  function showToast(message, type = 'info') {
    const container = document.getElementById('toast-container');
    if (!container) return;

    const toast = document.createElement('div');
    const colorClass = type === 'error'
      ? 'bg-rose-950/90 border-rose-500/50 text-rose-200'
      : type === 'warning'
      ? 'bg-amber-950/90 border-amber-500/50 text-amber-200'
      : type === 'success'
      ? 'bg-emerald-950/90 border-emerald-500/50 text-emerald-200'
      : 'bg-zinc-900/95 border-violet-500/40 text-zinc-100';

    toast.className = `flex items-center gap-2.5 rounded-xl border px-4 py-3 text-xs font-semibold shadow-xl backdrop-blur-md transition-all duration-300 transform translate-y-2 opacity-0 ${colorClass}`;
    toast.innerHTML = `
      <span>${escapeHtml(message)}</span>
    `;

    container.appendChild(toast);
    requestAnimationFrame(() => {
      toast.classList.remove('translate-y-2', 'opacity-0');
    });

    setTimeout(() => {
      toast.classList.add('opacity-0', 'translate-y-[-10px]');
      setTimeout(() => toast.remove(), 300);
    }, 4000);
  }

  function formatTime(sec) {
    const s = Math.floor(sec || 0);
    const m = Math.floor(s / 60);
    const rem = s % 60;
    return `${m}:${rem.toString().padStart(2, '0')}`;
  }

  function escapeHtml(str) {
    if (!str) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  return {
    init,
    joinRoom,
    fillPreset,
    removeQueueItem,
    showDriftBadge,
    notifyDuration
  };
})();

// Bootstrap app on DOM Content Loaded
document.addEventListener('DOMContentLoaded', () => {
  window.SyncBeatApp.init();
});
