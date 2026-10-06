/**
 * SyncBeat - Full-Stack Real-Time Synchronized Music Room Web Application
 * Express + Socket.io Server (Server-Authoritative Synchronization Engine)
 */

const http = require('http');
const path = require('path');
const fs = require('fs');
const express = require('express');
const cors = require('cors');
const { Server } = require('socket.io');

const roomManager = require('./src/roomManager');
const SlidingWindowRateLimiter = require('./src/rateLimiter');
const { extractVideoId, fetchVideoMetadata } = require('./src/youtubeHelper');

const app = express();
const server = http.createServer(app);

// CORS enabled Socket.io server
const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  }
});

const PORT = process.env.PORT || 3000;

// Rate limiter: 2 actions per 15-second sliding window per socket/IP
const actionRateLimiter = new SlidingWindowRateLimiter(2, 15000);

app.use(cors());
app.use(express.json());

// Helper function to build pre-rendered rooms HTML for zero-latency initial render
function renderRoomsHtml(rooms) {
  if (!rooms || rooms.length === 0) {
    return `
      <div class="col-span-full p-8 text-center rounded-2xl border border-zinc-800/80 bg-zinc-900/40 backdrop-blur-md">
        <p class="text-zinc-400 font-medium">No active rooms found. Be the first to create one!</p>
      </div>
    `;
  }

  return rooms.map(room => {
    const isLive = room.isPlaying;
    const count = room.listenerCount || 0;
    const safeName = escapeHtml(room.name);
    const safeTitle = escapeHtml(room.currentTitle || 'Unknown Track');
    const safeAuthor = escapeHtml(room.currentAuthor || 'SyncBeat Stream');
    const safeNorm = encodeURIComponent(room.normalizedName);
    const thumb = room.currentThumbnail || `https://img.youtube.com/vi/${room.currentVideoId}/hqdefault.jpg`;

    return `
      <div class="room-card group relative flex flex-col justify-between overflow-hidden rounded-2xl border border-zinc-800/80 bg-zinc-900/50 p-4 transition-all duration-300 hover:border-violet-500/50 hover:bg-zinc-900/90 hover:shadow-xl hover:shadow-violet-950/20 backdrop-blur-sm" data-room="${safeNorm}">
        <div>
          <!-- Thumbnail & Status -->
          <div class="relative aspect-video w-full overflow-hidden rounded-xl bg-zinc-950 border border-zinc-800/50">
            <img src="${thumb}" alt="${safeTitle}" class="h-full w-full object-cover transition-transform duration-500 group-hover:scale-105" loading="lazy" />
            <div class="absolute inset-0 bg-gradient-to-t from-black/80 via-transparent to-black/20"></div>
            
            <!-- Live Badge & Listener Count -->
            <div class="absolute top-2.5 left-2.5 flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-semibold backdrop-blur-md ${isLive ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30' : 'bg-amber-500/20 text-amber-400 border border-amber-500/30'}">
              <span class="relative flex h-2 w-2">
                ${isLive ? '<span class="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>' : ''}
                <span class="relative inline-flex rounded-full h-2 w-2 ${isLive ? 'bg-emerald-500' : 'bg-amber-500'}"></span>
              </span>
              <span>${isLive ? 'LIVE' : 'PAUSED'}</span>
            </div>

            <div class="absolute top-2.5 right-2.5 flex items-center gap-1.5 rounded-full bg-black/60 px-2.5 py-1 text-xs font-medium text-zinc-300 backdrop-blur-md border border-white/10">
              <svg class="w-3.5 h-3.5 text-violet-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 4.354a4 4 0 110 5.292M15 21H3v-1a6 6 0 0112 0v1zm0 0h6v-1a6 6 0 00-9-5.197M13 7a4 4 0 11-8 0 4 4 0 018 0z"></path></svg>
              <span class="listener-count-badge">${count} listener${count === 1 ? '' : 's'}</span>
            </div>

            <!-- Track Info overlay -->
            <div class="absolute bottom-2.5 left-2.5 right-2.5">
              <p class="truncate text-sm font-semibold text-white drop-shadow">${safeTitle}</p>
              <p class="truncate text-xs text-zinc-300 drop-shadow">${safeAuthor}</p>
            </div>
          </div>

          <!-- Room Title & Queue Info -->
          <div class="mt-3.5 flex items-center justify-between">
            <h3 class="text-base font-bold text-white group-hover:text-violet-300 transition-colors">${safeName}</h3>
            <span class="text-xs text-zinc-400 font-mono">${room.queueCount || 0} in queue</span>
          </div>
        </div>

        <!-- Join Button -->
        <div class="mt-4 pt-3 border-t border-zinc-800/60">
          <button onclick="window.SyncBeatApp.joinRoom('${safeNorm}')" class="w-full flex items-center justify-center gap-2 rounded-xl bg-violet-600/20 py-2 text-sm font-semibold text-violet-300 border border-violet-500/30 transition-all hover:bg-violet-600 hover:text-white hover:border-violet-600 hover:shadow-lg hover:shadow-violet-600/25 active:scale-[0.98]">
            <svg class="w-4 h-4" fill="currentColor" viewBox="0 0 20 20"><path d="M6.3 2.841A1.5 1.5 0 004 4.11V15.89a1.5 1.5 0 002.3 1.269l9.344-5.89a1.5 1.5 0 000-2.538L6.3 2.84z"></path></svg>
            Tune In Now
          </button>
        </div>
      </div>
    `;
  }).join('\n');
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

// Pre-rendered root route with active rooms showcase injected directly in initial HTML
app.get('/', (req, res) => {
  const indexPath = path.join(__dirname, 'public', 'index.html');
  fs.readFile(indexPath, 'utf8', (err, html) => {
    if (err) {
      return res.status(500).send('Error loading SyncBeat interface');
    }
    const publicRooms = roomManager.getPublicRoomsSummary();
    const renderedCards = renderRoomsHtml(publicRooms);
    const hydratedHtml = html.replace('<!-- PRE_RENDERED_ROOMS -->', renderedCards);
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(hydratedHtml);
  });
});

// Static assets (CSS, JS, images)
app.use(express.static(path.join(__dirname, 'public')));

// Public REST API endpoints
app.get('/api/rooms', (req, res) => {
  res.json({ success: true, rooms: roomManager.getPublicRoomsSummary() });
});

app.get('/api/rooms/:name', (req, res) => {
  const room = roomManager.getRoom(req.params.name);
  if (!room) {
    return res.status(404).json({ success: false, error: 'Room not found' });
  }
  res.json({ success: true, syncState: roomManager.getSyncPayload(room) });
});

app.post('/api/parse-url', async (req, res) => {
  const { input } = req.body;
  const videoId = extractVideoId(input);
  if (!videoId) {
    return res.status(400).json({ success: false, error: 'Invalid YouTube URL or Video ID' });
  }
  const metadata = await fetchVideoMetadata(videoId);
  res.json({ success: true, videoId, ...metadata });
});

// Socket.io Real-Time Synchronization Engine
io.on('connection', (socket) => {
  const clientIp = socket.handshake.address || socket.id;
  const clientKey = `${clientIp}:${socket.id}`;
  let currentRoom = null;
  let currentListener = null;

  // Rate Limiting Guard Helper
  function enforceRateLimit(actionName) {
    const check = actionRateLimiter.consume(clientKey);
    if (!check.allowed) {
      socket.emit('rate:limit_error', {
        action: actionName,
        message: 'Anti-Abuse: Action rate limit exceeded (maximum 2 actions per 15 seconds).',
        cooldownRemainingSec: check.cooldownRemainingSec
      });
      return false;
    }
    return true;
  }

  // 1. Join Room
  socket.on('join:room', ({ roomName, nickname }) => {
    if (!roomName) return;

    // Leave any previous room
    if (currentRoom) {
      handleLeave();
    }

    const { room, listener } = roomManager.joinRoom(roomName, socket.id, nickname);
    currentRoom = room;
    currentListener = listener;

    const socketRoomId = `room:${room.normalizedName}`;
    socket.join(socketRoomId);

    // Provide authoritative state to the newly joined client
    const syncState = roomManager.getSyncPayload(room);
    socket.emit('room:joined', {
      syncState,
      you: listener,
      cooldownRemainingSec: actionRateLimiter.getCooldown(clientKey)
    });

    // Notify all listeners in the room
    io.to(socketRoomId).emit('listeners:update', {
      listeners: Array.from(room.listeners.values())
    });

    // Broadcast system activity feed message
    io.to(socketRoomId).emit('activity:feed', {
      id: `act-${Date.now()}-${Math.random().toString(36).substr(2, 4)}`,
      type: 'system',
      text: `${listener.nickname} joined the room as ${listener.role === 'admin' ? '👑 Admin' : 'Listener'}.`,
      timestamp: Date.now()
    });

    // Broadcast public rooms update to lobby
    io.emit('lobby:rooms_update', { rooms: roomManager.getPublicRoomsSummary() });
  });

  // 2. Client resync request
  socket.on('sync:request', () => {
    if (!currentRoom) return;
    socket.emit('room:sync', roomManager.getSyncPayload(currentRoom));
  });

  // 3. Playback Toggle (Play / Pause)
  socket.on('playback:toggle', ({ isPlaying }) => {
    if (!currentRoom) return;

    // Rate limiting: max 2 actions per 15-second window
    if (!enforceRateLimit('playback:toggle')) return;

    // Role check: Only admin can toggle playback
    if (currentListener && currentListener.role !== 'admin') {
      socket.emit('action:error', { message: 'Only the room Admin can toggle playback.' });
      return;
    }

    let payload;
    if (isPlaying) {
      payload = roomManager.play(currentRoom);
    } else {
      payload = roomManager.pause(currentRoom);
    }

    const socketRoomId = `room:${currentRoom.normalizedName}`;
    io.to(socketRoomId).emit('room:sync', payload);

    io.to(socketRoomId).emit('activity:feed', {
      id: `act-${Date.now()}-${Math.random().toString(36).substr(2, 4)}`,
      type: 'system',
      text: `${currentListener.nickname} ${isPlaying ? 'resumed' : 'paused'} playback.`,
      timestamp: Date.now()
    });

    io.emit('lobby:rooms_update', { rooms: roomManager.getPublicRoomsSummary() });
  });

  // 4. Playback Seek
  socket.on('playback:seek', ({ targetSec }) => {
    if (!currentRoom) return;

    if (!enforceRateLimit('playback:seek')) return;

    if (currentListener && currentListener.role !== 'admin') {
      socket.emit('action:error', { message: 'Only the room Admin can seek playback position.' });
      return;
    }

    const payload = roomManager.seek(currentRoom, targetSec);
    const socketRoomId = `room:${currentRoom.normalizedName}`;
    io.to(socketRoomId).emit('room:sync', payload);

    io.to(socketRoomId).emit('activity:feed', {
      id: `act-${Date.now()}-${Math.random().toString(36).substr(2, 4)}`,
      type: 'system',
      text: `${currentListener.nickname} scrubbed to ${formatTime(targetSec)}.`,
      timestamp: Date.now()
    });
  });

  // 5. Play Track Now (Immediate Switch)
  socket.on('track:play_now', async ({ input }) => {
    if (!currentRoom) return;

    if (!enforceRateLimit('track:play_now')) return;

    if (currentListener && currentListener.role !== 'admin') {
      socket.emit('action:error', { message: 'Only the room Admin can immediately change tracks.' });
      return;
    }

    const videoId = extractVideoId(input);
    if (!videoId) {
      socket.emit('action:error', { message: 'Invalid YouTube URL or Video ID.' });
      return;
    }

    const metadata = await fetchVideoMetadata(videoId);
    const payload = roomManager.setTrack(currentRoom, {
      videoId,
      title: metadata.title,
      author: metadata.author,
      thumbnailUrl: metadata.thumbnailUrl,
      duration: 0
    });

    const socketRoomId = `room:${currentRoom.normalizedName}`;
    io.to(socketRoomId).emit('room:sync', payload);

    io.to(socketRoomId).emit('activity:feed', {
      id: `act-${Date.now()}-${Math.random().toString(36).substr(2, 4)}`,
      type: 'system',
      text: `🎵 Now Playing: "${metadata.title}" (started by ${currentListener.nickname}).`,
      timestamp: Date.now()
    });

    io.emit('lobby:rooms_update', { rooms: roomManager.getPublicRoomsSummary() });
  });

  // 6. Skip / Next Track
  socket.on('playback:skip', () => {
    if (!currentRoom) return;

    if (!enforceRateLimit('playback:skip')) return;

    if (currentListener && currentListener.role !== 'admin') {
      socket.emit('action:error', { message: 'Only the room Admin can skip tracks.' });
      return;
    }

    const payload = roomManager.skipTrack(currentRoom);
    const socketRoomId = `room:${currentRoom.normalizedName}`;

    io.to(socketRoomId).emit('room:sync', payload);
    io.to(socketRoomId).emit('queue:update', { queue: currentRoom.queue });

    io.to(socketRoomId).emit('activity:feed', {
      id: `act-${Date.now()}-${Math.random().toString(36).substr(2, 4)}`,
      type: 'system',
      text: `⏭ ${currentListener.nickname} skipped to: "${currentRoom.currentTitle}".`,
      timestamp: Date.now()
    });

    io.emit('lobby:rooms_update', { rooms: roomManager.getPublicRoomsSummary() });
  });

  // 7. Add Track to Queue (Any Listener can add to queue)
  socket.on('track:add_queue', async ({ input }) => {
    if (!currentRoom) return;

    const videoId = extractVideoId(input);
    if (!videoId) {
      socket.emit('action:error', { message: 'Invalid YouTube URL or Video ID.' });
      return;
    }

    const metadata = await fetchVideoMetadata(videoId);
    const addedTrack = roomManager.addToQueue(currentRoom, {
      videoId,
      title: metadata.title,
      author: metadata.author,
      thumbnailUrl: metadata.thumbnailUrl,
      duration: 0,
      addedBy: currentListener ? currentListener.nickname : 'Anonymous'
    });

    const socketRoomId = `room:${currentRoom.normalizedName}`;
    io.to(socketRoomId).emit('queue:update', { queue: currentRoom.queue });

    io.to(socketRoomId).emit('activity:feed', {
      id: `act-${Date.now()}-${Math.random().toString(36).substr(2, 4)}`,
      type: 'system',
      text: `➕ ${addedTrack.addedBy} added "${addedTrack.title}" to Up Next queue.`,
      timestamp: Date.now()
    });
  });

  // 8. Remove Track from Queue
  socket.on('queue:remove', ({ trackId }) => {
    if (!currentRoom) return;

    const track = currentRoom.queue.find(t => t.id === trackId);
    if (!track) return;

    // Allow if admin OR if this user added the track
    const isAdmin = currentListener && currentListener.role === 'admin';
    const isOwner = currentListener && currentListener.nickname === track.addedBy;

    if (!isAdmin && !isOwner) {
      socket.emit('action:error', { message: 'You can only remove tracks you added, or ask an Admin.' });
      return;
    }

    roomManager.removeFromQueue(currentRoom, trackId);
    const socketRoomId = `room:${currentRoom.normalizedName}`;
    io.to(socketRoomId).emit('queue:update', { queue: currentRoom.queue });

    io.to(socketRoomId).emit('activity:feed', {
      id: `act-${Date.now()}-${Math.random().toString(36).substr(2, 4)}`,
      type: 'system',
      text: `🗑 "${track.title}" was removed from the queue.`,
      timestamp: Date.now()
    });
  });

  // 9. Duration update from client player
  socket.on('player:duration', ({ duration }) => {
    if (!currentRoom) return;
    roomManager.updateDuration(currentRoom, duration);
  });

  // 10. Real-Time Chat Message
  socket.on('chat:send', ({ text }) => {
    if (!currentRoom || !text || typeof text !== 'string') return;
    const clean = text.trim();
    if (!clean) return;

    const socketRoomId = `room:${currentRoom.normalizedName}`;
    io.to(socketRoomId).emit('chat:message', {
      id: `chat-${Date.now()}-${Math.random().toString(36).substr(2, 4)}`,
      sender: currentListener ? currentListener.nickname : 'Anonymous',
      senderId: socket.id,
      role: currentListener ? currentListener.role : 'client',
      text: clean,
      timestamp: Date.now()
    });
  });

  // Disconnection handler
  function handleLeave() {
    if (!currentRoom) return;
    const result = roomManager.leaveRoom(socket.id);
    if (result) {
      const { room, leavingListener, newAdmin } = result;
      const socketRoomId = `room:${room.normalizedName}`;

      io.to(socketRoomId).emit('listeners:update', {
        listeners: Array.from(room.listeners.values())
      });

      io.to(socketRoomId).emit('activity:feed', {
        id: `act-${Date.now()}-${Math.random().toString(36).substr(2, 4)}`,
        type: 'system',
        text: `${leavingListener.nickname} left the room.`,
        timestamp: Date.now()
      });

      if (newAdmin) {
        io.to(socketRoomId).emit('activity:feed', {
          id: `act-${Date.now()}-${Math.random().toString(36).substr(2, 4)}`,
          type: 'system',
          text: `👑 ${newAdmin.nickname} is now the Room Admin.`,
          timestamp: Date.now()
        });
        io.to(newAdmin.id).emit('role:promoted', { role: 'admin' });
      }

      io.emit('lobby:rooms_update', { rooms: roomManager.getPublicRoomsSummary() });
    }
    currentRoom = null;
    currentListener = null;
  }

  socket.on('disconnect', () => {
    handleLeave();
  });
});

function formatTime(sec) {
  const s = Math.floor(sec || 0);
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return `${m}:${rem.toString().padStart(2, '0')}`;
}

server.listen(PORT, () => {
  console.log(`\n======================================================`);
  console.log(`🚀 SyncBeat Production Server running on port ${PORT}`);
  console.log(`📡 Local URL: http://localhost:${PORT}`);
  console.log(`🎵 Authoritative Room Sync Engine & Anti-Abuse Active`);
  console.log(`======================================================\n`);
});
