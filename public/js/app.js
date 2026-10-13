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

    // Browser navigation (Back / Forward) support
    window.addEventListener('popstate', (e) => {
      const urlParams = new URLSearchParams(window.location.search);
      const roomParam = urlParams.get('room');
      if (roomParam) {
        if (!currentRoom || currentRoom.normalizedName !== roomParam) {
          joinRoom(roomParam);
        }
      } else {
        if (currentRoom) {
          leaveRoom();
        }
      }
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

  function extractVideoId(input) {
    if (!input || typeof input !== 'string') return null;
    const clean = input.trim();
    if (/^[a-zA-Z0-9_-]{11}$/.test(clean)) return clean;
    try {
      const url = new URL(clean.startsWith('http') ? clean : 'https://' + clean);
      if (url.hostname.includes('youtube.com')) {
        if (url.searchParams.get('v')) return url.searchParams.get('v');
        const pathParts = url.pathname.split('/');
        const idx = pathParts.findIndex(p => p === 'v' || p === 'embed' || p === 'live');
        if (idx !== -1 && pathParts[idx + 1]) return pathParts[idx + 1].slice(0, 11);
      } else if (url.hostname.includes('youtu.be')) {
        const id = url.pathname.slice(1).split('/')[0].split('?')[0];
        if (id && id.length === 11) return id;
      }
    } catch (e) {}
    const m = clean.match(/(?:v=|\/embed\/|\/17\/|\/v\/|https:\/\/youtu\.be\/|\/watch\?v=|\/watch\?.+&v=)([\w-]{11})/);
    return m ? m[1] : null;
  }

  // Standalone / P2P Fallback Engine (Runs when no Node.js backend is detected)
  const StandaloneEngine = {
    channel: null,
    peer: null,
    peerConns: [],
    clientConn: null,
    active: false,
    roomData: null,
    isHost: false,

    initRoom(roomName, nickname) {
      const cleanName = typeof roomName === 'string' ? decodeURIComponent(roomName).trim() : 'Music Room';
      const norm = cleanName.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'music-room';

      const defaultVideo = PRESETS[0] ? PRESETS[0].id : 'jfKfPfyJRdk';
      let storedRoom = null;
      try {
        const raw = localStorage.getItem('syncbeat_room_' + norm);
        if (raw) storedRoom = JSON.parse(raw);
      } catch (e) {}

      const now = Date.now();
      const initialRoom = storedRoom || {
        name: cleanName,
        normalizedName: norm,
        currentVideoId: defaultVideo,
        currentTitle: 'Lofi Hip Hop Radio - Beats to Relax/Study to',
        currentAuthor: 'Lofi Girl',
        currentThumbnail: `https://img.youtube.com/vi/${defaultVideo}/hqdefault.jpg`,
        isPlaying: true,
        startedAt: now,
        pausedAtSec: 0,
        duration: 0,
        queue: [
          {
            id: 'q-seed-1',
            videoId: '4xDzrJKXOOY',
            title: 'Synthwave Radio - Chill Synth / Retro Beats',
            author: 'Lofi Girl',
            thumbnailUrl: 'https://img.youtube.com/vi/4xDzrJKXOOY/hqdefault.jpg',
            duration: 0,
            addedBy: 'SyncBeat'
          }
        ],
        listeners: []
      };

      this.roomData = initialRoom;
      this.active = true;

      // BroadcastChannel for instant local multi-tab synchronization
      if (typeof BroadcastChannel !== 'undefined') {
        if (this.channel) this.channel.close();
        this.channel = new BroadcastChannel('syncbeat_room_' + norm);
        this.channel.onmessage = (event) => this.handleChannelMessage(event.data);
      }

      const user = {
        id: 'usr-' + Math.random().toString(36).substring(2, 8),
        nickname: nickname || localStorage.getItem('syncbeat_nickname') || 'Guest',
        role: 'admin',
        joinedAt: now
      };

      this.roomData.listeners = [user];
      currentUser = user;
      currentRole = user.role;

      const syncState = this.getSyncPayload();
      currentRoom = syncState;

      const newUrl = `${window.location.pathname}?room=${encodeURIComponent(norm)}`;
      if (window.location.search !== `?room=${encodeURIComponent(norm)}`) {
        window.history.pushState({ room: norm }, '', newUrl);
      }

      const chatContainer = document.getElementById('chat-messages-container');
      if (chatContainer) chatContainer.innerHTML = '';

      showRoomView(syncState);
      applyRoomState(syncState);

      appendFeedItem({
        id: 'sys-start',
        type: 'system',
        text: `👑 Welcome ${user.nickname}! You are the Room Admin. Share this room's invite link with visitors so they listen in sync.`,
        timestamp: now
      });

      if (this.channel) {
        this.channel.postMessage({ type: 'user_joined', user, syncState });
      }

      showToast(`Entered ${cleanName} as 👑 Admin!`, 'success');
      this.saveLocal();

      // Initialize WebRTC P2P (PeerJS) for cross-device sync
      this.setupP2P(norm, user);
    },

    setupP2P(norm, user) {
      if (typeof Peer === 'undefined') return;
      this.closeP2P();

      const hostPeerId = `syncbeat-v1-${norm}`.substring(0, 60);

      try {
        const hostPeer = new Peer(hostPeerId, { debug: 0 });
        this.peer = hostPeer;

        hostPeer.on('open', (id) => {
          console.log('[SyncBeat P2P] Hosting room as Admin:', id);
          this.isHost = true;
          this.roomData.listeners = [user];
          renderListeners(this.roomData.listeners);
        });

        hostPeer.on('connection', (conn) => {
          console.log('[SyncBeat P2P] Visitor connected:', conn.peer);
          this.peerConns.push(conn);

          conn.on('open', () => {
            conn.send({
              type: 'sync',
              syncState: this.getSyncPayload(),
              host: currentUser
            });
          });

          conn.on('data', (data) => {
            if (!data) return;
            if (data.type === 'visitor_joined' && data.user) {
              const visitor = { ...data.user, role: 'client' };
              if (!this.roomData.listeners.find(l => l.id === visitor.id)) {
                this.roomData.listeners.push(visitor);
              }
              renderListeners(this.roomData.listeners);
              this.broadcast({ type: 'listeners', listeners: this.roomData.listeners });
              appendFeedItem({
                id: 'act-' + Date.now(),
                type: 'system',
                text: `${visitor.nickname} joined the room as a listener.`,
                timestamp: Date.now()
              });
              showToast(`${visitor.nickname} joined the room!`, 'info');
            } else if (data.type === 'chat' && data.message) {
              appendChatMessage(data.message);
              this.broadcast({ type: 'chat', message: data.message }, conn);
            } else if (data.type === 'queue_add' && data.track) {
              this.roomData.queue.push(data.track);
              this.saveLocal();
              renderQueue(this.roomData.queue);
              this.broadcast({ type: 'queue', queue: this.roomData.queue });
              appendFeedItem({
                id: 'act-' + Date.now(),
                type: 'system',
                text: `➕ ${data.track.addedBy} added "${data.track.title}" to Up Next.`,
                timestamp: Date.now()
              });
            }
          });

          conn.on('close', () => {
            this.peerConns = this.peerConns.filter(c => c !== conn);
          });
        });

        hostPeer.on('error', (err) => {
          if (err.type === 'unavailable-id') {
            console.log('[SyncBeat P2P] Room host already active on another client. Connecting as visitor...');
            hostPeer.destroy();
            this.connectAsVisitor(hostPeerId, user);
          } else {
            console.warn('[SyncBeat P2P] Host peer error:', err);
          }
        });
      } catch (e) {
        console.warn('[SyncBeat P2P] Exception initializing P2P host:', e);
      }
    },

    connectAsVisitor(hostPeerId, user) {
      if (typeof Peer === 'undefined') return;
      try {
        const clientPeer = new Peer(undefined, { debug: 0 });
        this.peer = clientPeer;

        clientPeer.on('open', (myId) => {
          console.log('[SyncBeat P2P] Connecting to room host:', hostPeerId);
          const conn = clientPeer.connect(hostPeerId, { reliable: true });
          this.clientConn = conn;

          conn.on('open', () => {
            console.log('[SyncBeat P2P] Connected to host!');
            user.role = 'client';
            currentRole = 'client';
            currentUser = user;
            updateAdminControlsVisibility();

            conn.send({
              type: 'visitor_joined',
              user: currentUser
            });

            showToast('Connected to 👑 Room Host! Synchronizing playback...', 'success');
          });

          conn.on('data', (data) => {
            if (!data) return;
            if (data.type === 'sync' && data.syncState) {
              currentRoom = data.syncState;
              applyRoomState(data.syncState);
            } else if (data.type === 'listeners' && data.listeners) {
              if (this.roomData) this.roomData.listeners = data.listeners;
              renderListeners(data.listeners);
            } else if (data.type === 'queue' && data.queue) {
              if (this.roomData) this.roomData.queue = data.queue;
              renderQueue(data.queue);
            } else if (data.type === 'chat' && data.message) {
              appendChatMessage(data.message);
            }
          });

          conn.on('close', () => {
            showToast('Room Host disconnected. You are now the room host!', 'warning');
            currentRole = 'admin';
            if (currentUser) currentUser.role = 'admin';
            updateAdminControlsVisibility();
          });
        });
      } catch (e) {
        console.warn('[SyncBeat P2P] Exception connecting as visitor:', e);
      }
    },

    broadcast(data, excludeConn) {
      if (this.peerConns && this.peerConns.length > 0) {
        this.peerConns.forEach(c => {
          if (c !== excludeConn && c.open) {
            try { c.send(data); } catch (e) {}
          }
        });
      }
      if (this.channel) {
        try { this.channel.postMessage(data); } catch (e) {}
      }
    },

    getSyncPayload() {
      if (!this.roomData) return null;
      let elapsed = 0;
      if (this.roomData.isPlaying) {
        elapsed = (Date.now() - this.roomData.startedAt) / 1000;
        if (this.roomData.duration > 0) elapsed = elapsed % this.roomData.duration;
      } else {
        elapsed = this.roomData.pausedAtSec;
      }
      return {
        name: this.roomData.name,
        normalizedName: this.roomData.normalizedName,
        currentVideoId: this.roomData.currentVideoId,
        currentTitle: this.roomData.currentTitle,
        currentAuthor: this.roomData.currentAuthor,
        currentThumbnail: this.roomData.currentThumbnail,
        isPlaying: this.roomData.isPlaying,
        serverTimestamp: Date.now(),
        currentElapsedSec: Math.max(0, elapsed),
        duration: this.roomData.duration || 0,
        queue: this.roomData.queue || [],
        listeners: this.roomData.listeners || []
      };
    },

    saveLocal() {
      if (!this.roomData) return;
      try {
        localStorage.setItem('syncbeat_room_' + this.roomData.normalizedName, JSON.stringify(this.roomData));
      } catch (e) {}
    },

    togglePlayback(nextPlaying) {
      if (!this.roomData) return;
      if (nextPlaying) {
        this.roomData.isPlaying = true;
        this.roomData.startedAt = Date.now() - (this.roomData.pausedAtSec * 1000);
      } else {
        const elapsed = (Date.now() - this.roomData.startedAt) / 1000;
        this.roomData.isPlaying = false;
        this.roomData.pausedAtSec = Math.max(0, elapsed);
      }
      this.saveLocal();
      const payload = this.getSyncPayload();
      currentRoom = payload;
      applyRoomState(payload);
      this.broadcast({ type: 'sync', syncState: payload });

      appendFeedItem({
        id: 'act-' + Date.now(),
        type: 'system',
        text: `${currentUser ? currentUser.nickname : 'Admin'} ${nextPlaying ? 'resumed' : 'paused'} playback.`,
        timestamp: Date.now()
      });
    },

    seek(targetSec) {
      if (!this.roomData) return;
      this.roomData.startedAt = Date.now() - (targetSec * 1000);
      this.roomData.pausedAtSec = targetSec;
      this.saveLocal();
      const payload = this.getSyncPayload();
      currentRoom = payload;
      applyRoomState(payload);
      this.broadcast({ type: 'sync', syncState: payload });
    },

    playTrack(videoId, title, author) {
      if (!this.roomData) return;
      this.roomData.currentVideoId = videoId;
      this.roomData.currentTitle = title || 'Custom Track';
      this.roomData.currentAuthor = author || 'YouTube Stream';
      this.roomData.currentThumbnail = `https://img.youtube.com/vi/${videoId}/hqdefault.jpg`;
      this.roomData.startedAt = Date.now();
      this.roomData.pausedAtSec = 0;
      this.roomData.isPlaying = true;
      this.saveLocal();
      const payload = this.getSyncPayload();
      currentRoom = payload;
      applyRoomState(payload);
      this.broadcast({ type: 'sync', syncState: payload });

      appendFeedItem({
        id: 'act-' + Date.now(),
        type: 'system',
        text: `🎵 Now Playing: "${this.roomData.currentTitle}" (started by Admin).`,
        timestamp: Date.now()
      });
    },

    skip() {
      if (!this.roomData || !this.roomData.queue || this.roomData.queue.length === 0) {
        showToast('Queue is empty! Add songs to skip.', 'info');
        return;
      }
      const next = this.roomData.queue.shift();
      this.playTrack(next.videoId, next.title, next.author);
      renderQueue(this.roomData.queue);
      this.broadcast({ type: 'queue', queue: this.roomData.queue });
    },

    addToQueue(videoId, title, author) {
      if (!this.roomData) return;
      const track = {
        id: 'q-' + Date.now(),
        videoId,
        title: title || 'YouTube Track',
        author: author || 'YouTube',
        thumbnailUrl: `https://img.youtube.com/vi/${videoId}/hqdefault.jpg`,
        duration: 0,
        addedBy: currentUser ? currentUser.nickname : 'Guest'
      };

      if (this.clientConn && this.clientConn.open) {
        this.clientConn.send({ type: 'queue_add', track });
        showToast(`Sent "${track.title}" to Host Up Next queue!`, 'success');
        return;
      }

      this.roomData.queue.push(track);
      this.saveLocal();
      renderQueue(this.roomData.queue);
      this.broadcast({ type: 'queue', queue: this.roomData.queue });

      appendFeedItem({
        id: 'act-' + Date.now(),
        type: 'system',
        text: `➕ ${track.addedBy} added "${track.title}" to Up Next.`,
        timestamp: Date.now()
      });
      showToast(`Added "${track.title}" to Up Next!`, 'success');
    },

    removeFromQueue(trackId) {
      if (!this.roomData) return;
      this.roomData.queue = this.roomData.queue.filter(t => t.id !== trackId);
      this.saveLocal();
      renderQueue(this.roomData.queue);
      this.broadcast({ type: 'queue', queue: this.roomData.queue });
    },

    sendChat(text) {
      const msg = {
        id: 'msg-' + Date.now(),
        sender: currentUser ? currentUser.nickname : 'Guest',
        senderId: currentUser ? currentUser.id : 'me',
        role: currentRole,
        text,
        timestamp: Date.now()
      };
      appendChatMessage(msg);

      if (this.clientConn && this.clientConn.open) {
        this.clientConn.send({ type: 'chat', message: msg });
      } else {
        this.broadcast({ type: 'chat', message: msg });
      }
    },

    handleChannelMessage(data) {
      if (!data) return;
      if (data.type === 'sync' && data.syncState) {
        if (currentRole !== 'admin') {
          currentRoom = data.syncState;
          applyRoomState(data.syncState);
        }
      } else if (data.type === 'chat' && data.message) {
        appendChatMessage(data.message);
      } else if (data.type === 'queue' && data.queue) {
        if (this.roomData) this.roomData.queue = data.queue;
        renderQueue(data.queue);
      } else if (data.type === 'listeners' && data.listeners) {
        if (this.roomData) this.roomData.listeners = data.listeners;
        renderListeners(data.listeners);
      } else if (data.type === 'user_joined') {
        appendFeedItem({
          id: 'act-' + Date.now(),
          type: 'system',
          text: `${data.user.nickname} joined the room.`,
          timestamp: Date.now()
        });
      }
    },

    closeP2P() {
      if (this.clientConn) {
        try { this.clientConn.close(); } catch (e) {}
        this.clientConn = null;
      }
      if (this.peerConns) {
        this.peerConns.forEach(c => {
          try { c.close(); } catch (e) {}
        });
        this.peerConns = [];
      }
      if (this.peer) {
        try { this.peer.destroy(); } catch (e) {}
        this.peer = null;
      }
      this.isHost = false;
    },

    leave() {
      this.active = false;
      this.closeP2P();
      if (this.channel) {
        this.channel.close();
        this.channel = null;
      }
    }
  };

  // Socket.io Connection & Listeners
  function initSocket() {
    const urlParams = new URLSearchParams(window.location.search);
    const paramBackend = urlParams.get('backend');
    if (paramBackend) {
      localStorage.setItem('syncbeat_backend_url', paramBackend.trim().replace(/\/+$/, ''));
    }

    const storedBackend = localStorage.getItem('syncbeat_backend_url');
    const backendUrl = paramBackend || storedBackend || window.__SYNCBEAT_BACKEND_URL__ || (window.location.hostname === 'localhost' ? '' : undefined);

    socket = backendUrl ? io(backendUrl) : io();

    socket.on('connect', () => {
      console.log('[SyncBeat] Socket connected:', socket.id);
      updateConnectionStatus(true);
      const warnBanner = document.getElementById('connection-warning-banner');
      if (warnBanner) warnBanner.classList.add('hidden');

      // If reconnecting while already viewing a room, seamlessly rejoin
      if (currentRoom && currentRoom.normalizedName) {
        const storedNick = localStorage.getItem('syncbeat_nickname') || 'Guest';
        socket.emit('join:room', {
          roomName: currentRoom.normalizedName,
          nickname: currentUser ? currentUser.nickname : storedNick
        });
      }
    });

    socket.on('connect_error', (err) => {
      console.warn('[SyncBeat] Socket connection error:', err);
      updateConnectionStatus(false);
      const warnBanner = document.getElementById('connection-warning-banner');
      if (warnBanner) warnBanner.classList.remove('hidden');
    });

    socket.on('disconnect', () => {
      console.warn('[SyncBeat] Socket disconnected');
      updateConnectionStatus(false);
      const warnBanner = document.getElementById('connection-warning-banner');
      if (warnBanner) warnBanner.classList.remove('hidden');
    });

    socket.on('room:joined', ({ syncState, you, cooldownRemainingSec }) => {
      const isSwitchingRoom = !currentRoom || currentRoom.normalizedName !== syncState.normalizedName;
      currentUser = you;
      currentRole = you.role;
      currentRoom = syncState;

      // Update URL query without full reload
      const newUrl = `${window.location.pathname}?room=${encodeURIComponent(syncState.normalizedName)}`;
      if (window.location.search !== `?room=${encodeURIComponent(syncState.normalizedName)}`) {
        window.history.pushState({ room: syncState.normalizedName }, '', newUrl);
      }

      // If switching or entering a fresh room, clear previous room's chat feed
      if (isSwitchingRoom) {
        const chatContainer = document.getElementById('chat-messages-container');
        if (chatContainer) chatContainer.innerHTML = '';
      }

      showRoomView(syncState);
      applyRoomState(syncState);

      if (cooldownRemainingSec > 0) {
        startCooldownTimer(cooldownRemainingSec);
      }

      showToast(`Joined ${syncState.name} as ${you.role === 'admin' ? '👑 Admin' : 'Listener'}!`, 'success');
    });

    socket.on('room:left', () => {
      leaveRoomLocal();
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

    if (window.YT && window.YT.Player) {
      window.onYouTubeIframeAPIReady();
    } else if (!window.YT) {
      const tag = document.createElement('script');
      tag.src = 'https://www.youtube.com/iframe_api';
      const firstScriptTag = document.getElementsByTagName('script')[0];
      if (firstScriptTag && firstScriptTag.parentNode) {
        firstScriptTag.parentNode.insertBefore(tag, firstScriptTag);
      } else if (document.head) {
        document.head.appendChild(tag);
      }
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
        if (socket && socket.connected) {
          socket.emit('playback:skip');
        } else {
          StandaloneEngine.skip();
        }
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
        if (socket && socket.connected) {
          socket.emit('playback:toggle', { isPlaying: nextState });
        } else {
          StandaloneEngine.togglePlayback(nextState);
        }
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
        if (socket && socket.connected) {
          socket.emit('playback:skip');
        } else {
          StandaloneEngine.skip();
        }
      });
    }

    // Force Resync Button
    const btnResync = document.getElementById('btn-resync');
    if (btnResync) {
      btnResync.addEventListener('click', () => {
        window.SyncBeatAudioUnlock.triggerUnlock();
        unmuteAndSetVolume();
        window.SyncBeatEngine.forceResync();
        if (socket && socket.connected) {
          socket.emit('sync:request');
        } else {
          const payload = StandaloneEngine.getSyncPayload();
          if (payload) applyRoomState(payload);
        }
        showToast('Resynchronized with room stream.', 'info');
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
            if (socket && socket.connected) {
              socket.emit('playback:seek', { targetSec });
            } else {
              StandaloneEngine.seek(targetSec);
            }
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
        if (socket && socket.connected) {
          socket.emit('track:play_now', { input: val });
        } else {
          const vid = extractVideoId(val);
          if (vid) {
            StandaloneEngine.playTrack(vid, `YouTube Track (${vid})`, 'Direct Stream');
          } else {
            showToast('Invalid YouTube URL or video ID.', 'error');
          }
        }
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
        if (socket && socket.connected) {
          socket.emit('track:add_queue', { input: val });
        } else {
          const vid = extractVideoId(val);
          if (vid) {
            StandaloneEngine.addToQueue(vid, `YouTube Track (${vid})`, 'Direct Stream');
          } else {
            showToast('Invalid YouTube URL or video ID.', 'error');
          }
        }
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
          if (socket && socket.connected) {
            socket.emit('chat:send', { text });
          } else {
            StandaloneEngine.sendChat(text);
          }
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
        leaveRoom();
      });
    }

    // Header logo click navigates to lobby cleanly without page reload
    const logoLink = document.querySelector('header a[href="/"]');
    if (logoLink) {
      logoLink.addEventListener('click', (e) => {
        e.preventDefault();
        leaveRoom();
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
    const cleanRoom = typeof roomName === 'string' ? decodeURIComponent(roomName).trim() : roomName;
    if (socket && socket.connected) {
      socket.emit('join:room', { roomName: cleanRoom, nickname: finalNick });
    } else {
      StandaloneEngine.initRoom(cleanRoom, finalNick);
    }
  }

  function showRoomView(syncState) {
    const lobbyView = document.getElementById('lobby-view');
    const roomView = document.getElementById('room-view');
    const inviteBtn = document.getElementById('btn-copy-invite');
    const leaveBtn = document.getElementById('btn-leave-room');

    if (lobbyView) lobbyView.classList.add('hidden');
    if (roomView) roomView.classList.remove('hidden');
    if (inviteBtn) inviteBtn.classList.remove('hidden');
    if (leaveBtn) {
      leaveBtn.classList.remove('hidden');
      leaveBtn.innerHTML = `
        <svg class="w-3.5 h-3.5 text-zinc-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10 19l-7-7m0 0l7-7m-7 7h18"/></svg>
        <span>Leave Room</span>
      `;
    }

    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function showLobbyView() {
    const lobbyView = document.getElementById('lobby-view');
    const roomView = document.getElementById('room-view');
    const inviteBtn = document.getElementById('btn-copy-invite');
    const leaveBtn = document.getElementById('btn-leave-room');

    if (roomView) roomView.classList.add('hidden');
    if (lobbyView) lobbyView.classList.remove('hidden');
    if (inviteBtn) inviteBtn.classList.add('hidden');
    if (leaveBtn) leaveBtn.classList.add('hidden');

    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function leaveRoom() {
    if (socket && socket.connected && currentRoom) {
      socket.emit('leave:room');
    }
    if (StandaloneEngine.active) {
      StandaloneEngine.leave();
    }
    leaveRoomLocal();
  }

  function leaveRoomLocal() {
    currentRoom = null;
    currentUser = null;
    currentRole = 'client';

    // Stop playback and sync engine
    if (window.SyncBeatEngine && typeof window.SyncBeatEngine.stop === 'function') {
      window.SyncBeatEngine.stop();
    }
    if (ytPlayer) {
      try {
        if (typeof ytPlayer.pauseVideo === 'function') {
          ytPlayer.pauseVideo();
        }
      } catch (e) {}
    }

    // Clear room data from DOM
    const chatContainer = document.getElementById('chat-messages-container');
    if (chatContainer) chatContainer.innerHTML = '';
    const queueContainer = document.getElementById('queue-list');
    if (queueContainer) queueContainer.innerHTML = '';
    const listenersContainer = document.getElementById('listeners-list');
    if (listenersContainer) listenersContainer.innerHTML = '';

    showLobbyView();

    // Reset URL to /
    if (window.location.search) {
      window.history.pushState({}, '', window.location.pathname);
    }
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
    if (socket && socket.connected) {
      socket.emit('queue:remove', { trackId });
    } else {
      StandaloneEngine.removeFromQueue(trackId);
    }
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
        <div onclick="window.SyncBeatApp.joinRoom('${safeNorm}')" class="room-card group relative flex flex-col justify-between overflow-hidden rounded-2xl border border-zinc-800/80 bg-zinc-900/50 p-4 transition-all duration-300 hover:border-violet-500/50 hover:bg-zinc-900/90 hover:shadow-xl hover:shadow-violet-950/20 backdrop-blur-sm cursor-pointer" data-room="${safeNorm}">
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
    const raf = typeof requestAnimationFrame === 'function' ? requestAnimationFrame : (fn) => setTimeout(fn, 16);
    raf(() => {
      toast.classList.remove('translate-y-2', 'opacity-0');
    });

    setTimeout(() => {
      toast.classList.add('opacity-0', 'translate-y-[-10px]');
      setTimeout(() => {
        if (typeof toast.remove === 'function') toast.remove();
        else if (toast.parentNode) toast.parentNode.removeChild(toast);
      }, 300);
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

  function copyRoomLink() {
    if (!currentRoom) return;
    const currentBackend = localStorage.getItem('syncbeat_backend_url');
    let shareUrl = `${window.location.origin}/?room=${encodeURIComponent(currentRoom.normalizedName)}`;
    if (currentBackend && !shareUrl.includes('backend=')) {
      shareUrl += `&backend=${encodeURIComponent(currentBackend)}`;
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(shareUrl).then(() => {
        showToast('Invite link copied! Share it with visitors so they listen in sync.', 'success');
      }).catch(() => {
        if (typeof window !== 'undefined' && typeof window.prompt === 'function') {
          window.prompt('Copy this room invite link to share with visitors:', shareUrl);
        }
      });
    } else if (typeof window !== 'undefined' && typeof window.prompt === 'function') {
      window.prompt('Copy this room invite link to share with visitors:', shareUrl);
    }
  }

  function promptBackendUrl() {
    const current = localStorage.getItem('syncbeat_backend_url') || '';
    const entered = prompt(
      'Enter your SyncBeat Node.js Server URL (e.g. https://your-server.onrender.com or http://localhost:3000):',
      current
    );
    if (entered !== null) {
      const clean = entered.trim().replace(/\/+$/, '');
      if (clean) {
        localStorage.setItem('syncbeat_backend_url', clean);
      } else {
        localStorage.removeItem('syncbeat_backend_url');
      }
      window.location.reload();
    }
  }

  return {
    init,
    joinRoom,
    leaveRoom,
    copyRoomLink,
    promptBackendUrl,
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
