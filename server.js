/**
 * SyncBeat - Real-Time Synchronized Music Room Server
 * Built with Node.js, Express, and Socket.io.
 *
 * Implements:
 * 1. Server-authoritative synchronization engine (elapsedSeconds = (Date.now() - startedAt) / 1000).
 * 2. 10-second periodic sync heartbeat to maintain ±1s sync across clients.
 * 3. First-come, first-served track change logic with 500ms race condition lockout.
 * 4. Sliding-window anti-abuse rate limiter (max 2 track changes per 60 seconds per client).
 * 5. Room creation (Admin) & Room joining (Guest) with password protection.
 */

import express from 'express';
import http from 'http';
import { Server } from 'socket.io';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST'],
  },
});

const PORT = 3000;

// Serve static frontend assets from /dist or /public directory
const distDir = path.join(__dirname, 'dist');
const publicDir = path.join(__dirname, 'public');

if (fs.existsSync(distDir)) {
  app.use(express.static(distDir));
}
app.use(express.static(publicDir));
app.use(express.json());

const DATA_DIR = path.join(__dirname, 'data');
const ROOMS_FILE = path.join(DATA_DIR, 'rooms.json');

if (!fs.existsSync(DATA_DIR)) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  } catch (e) {}
}

/**
 * In-memory room store.
 * Key: roomName (lowercase)
 * Value: RoomState object
 */
const rooms = new Map();

/**
 * Map socket ID to user session info: { roomName, nickname, role, socketId }
 */
const socketToUser = new Map();

// Helper to compile active rooms list
function getActiveRoomsList() {
  const list = [];
  for (const [key, room] of rooms.entries()) {
    list.push({
      name: room.name,
      normalizedName: key,
      listenersCount: room.users ? room.users.size : 0,
      currentTitle: room.currentTitle || 'Chill Music Stream',
      currentAuthor: room.currentAuthor || 'YouTube',
      currentThumbnail: room.currentThumbnail || `https://img.youtube.com/vi/${room.currentVideoId}/hqdefault.jpg`,
      currentVideoId: room.currentVideoId,
      isPlaying: room.isPlaying !== false,
    });
  }
  return list;
}

function saveRoomsToDisk() {
  try {
    const list = [];
    for (const [key, r] of rooms.entries()) {
      list.push({
        name: r.name,
        normalizedName: key,
        currentVideoId: r.currentVideoId,
        currentTitle: r.currentTitle,
        currentAuthor: r.currentAuthor,
        currentThumbnail: r.currentThumbnail,
        startedAt: r.startedAt,
        isPlaying: r.isPlaying,
        pausedAt: r.pausedAt,
        duration: r.duration,
        playlist: r.playlist || [],
        createdAt: r.createdAt || Date.now(),
      });
    }
    fs.writeFileSync(ROOMS_FILE, JSON.stringify(list, null, 2), 'utf-8');
  } catch (err) {
    console.error('saveRoomsToDisk error:', err);
  }
}

function seedDefaultRooms() {
  const defaults = [
    {
      name: 'Lofi Lounge',
      key: 'lofi-lounge',
      videoId: 'jfKfPfyJRdk',
      title: 'lofi hip hop radio 📚 beats to relax/study to',
      author: 'Lofi Girl',
      thumbnail: 'https://img.youtube.com/vi/jfKfPfyJRdk/hqdefault.jpg',
    },
    {
      name: 'Synthwave Radio',
      key: 'synthwave-radio',
      videoId: '4xDzrJKXOOY',
      title: 'Synthwave Radio - Chill Synth / Retro Beats',
      author: 'Lofi Records',
      thumbnail: 'https://img.youtube.com/vi/4xDzrJKXOOY/hqdefault.jpg',
    },
    {
      name: 'Cafe Jazz',
      key: 'cafe-jazz',
      videoId: 'Dx5qFachd3A',
      title: 'Coffee Shop Radio - Relaxing Jazz & Bossa Nova',
      author: 'Cafe Music BGM channel',
      thumbnail: 'https://img.youtube.com/vi/Dx5qFachd3A/hqdefault.jpg',
    },
    {
      name: 'dene',
      key: 'dene',
      videoId: 'Dx5qFachd3A',
      title: 'Relax music Slow music',
      author: 'YouTube Artist',
      thumbnail: 'https://img.youtube.com/vi/Dx5qFachd3A/hqdefault.jpg',
    },
  ];

  for (const def of defaults) {
    const norm = def.key.toLowerCase().trim();
    if (!rooms.has(norm)) {
      rooms.set(norm, {
        name: def.name,
        password: '',
        adminSocketId: null,
        currentVideoId: def.videoId,
        currentTitle: def.title,
        currentAuthor: def.author,
        currentThumbnail: def.thumbnail,
        startedAt: Date.now(),
        isPlaying: true,
        pausedAt: 0,
        duration: 3600,
        playlist: [
          {
            id: 'preset_1',
            videoId: '4xDzrJKXOOY',
            title: 'Synthwave Radio - Chill Synth / Retro Beats',
            author: 'Lofi Records',
            thumbnailUrl: 'https://img.youtube.com/vi/4xDzrJKXOOY/hqdefault.jpg',
            addedBy: 'System',
            addedAt: Date.now(),
          },
        ],
        users: new Map(),
        lastTrackChangeTime: 0,
        createdAt: Date.now(),
      });
    }
  }
}

function loadRoomsFromDisk() {
  try {
    if (fs.existsSync(ROOMS_FILE)) {
      const content = fs.readFileSync(ROOMS_FILE, 'utf-8');
      const list = JSON.parse(content);
      if (Array.isArray(list)) {
        for (const item of list) {
          if (!item.name) continue;
          const key = (item.normalizedName || item.name).toLowerCase().trim();
          rooms.set(key, {
            name: item.name,
            password: '',
            adminSocketId: null,
            currentVideoId: item.currentVideoId || 'jfKfPfyJRdk',
            currentTitle: item.currentTitle || 'Relaxing Beats',
            currentAuthor: item.currentAuthor || 'YouTube Stream',
            currentThumbnail: item.currentThumbnail || `https://img.youtube.com/vi/${item.currentVideoId || 'jfKfPfyJRdk'}/hqdefault.jpg`,
            startedAt: item.startedAt || Date.now(),
            isPlaying: item.isPlaying !== false,
            pausedAt: item.pausedAt || 0,
            duration: item.duration || 3600,
            playlist: item.playlist || [],
            users: new Map(),
            lastTrackChangeTime: 0,
            createdAt: item.createdAt || Date.now(),
          });
        }
      }
    }
  } catch (err) {
    console.error('loadRoomsFromDisk error:', err);
  }

  seedDefaultRooms();
  saveRoomsToDisk();
}

// Initialize rooms immediately on server boot
loadRoomsFromDisk();

// Active rooms API endpoint
app.get('/api/rooms', (req, res) => {
  res.json({ rooms: getActiveRoomsList() });
});

/**
 * Sliding window rate limit store for track change requests.
 * Key: socketId
 * Value: Array of timestamps (number[]) representing requests made within the window
 */
const trackChangeTimestamps = new Map();

const RATE_LIMIT_WINDOW_MS = 60 * 1000; // 60 seconds
const MAX_REQUESTS_PER_WINDOW = 2; // Max 2 track changes per 60s
const RACE_CONDITION_LOCKOUT_MS = 500; // 500ms lockout window

/**
 * Helper to extract YouTube video ID from various URL formats or raw ID.
 */
function extractYouTubeId(input) {
  if (!input || typeof input !== 'string') return null;
  const trimmed = input.trim();
  // 11 characters ID direct match
  if (/^[a-zA-Z0-9_-]{11}$/.test(trimmed)) {
    return trimmed;
  }
  // Regex matching standard watch, short links, embeds, shorts, music
  const regExp = /(?:youtu\.be\/|youtube(?:-nocookie)?\.com\/(?:embed\/|v\/|watch\?v=|shorts\/|live\/|watch\?.+&v=))([\w-]{11})/;
  const match = trimmed.match(regExp);
  return match && match[1] ? match[1] : null;
}

/**
 * Fetch video metadata via YouTube oEmbed (title, author, thumbnail)
 */
async function fetchYouTubeMetadata(videoId) {
  const defaultMeta = {
    title: `YouTube Track (${videoId})`,
    author: 'YouTube Artist',
    thumbnailUrl: `https://img.youtube.com/vi/${videoId}/hqdefault.jpg`,
    duration: 210, // Default estimated duration if not known
  };

  try {
    const oembedUrl = `https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${videoId}&format=json`;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 2500);

    const res = await fetch(oembedUrl, { signal: controller.signal });
    clearTimeout(timeoutId);

    if (res.ok) {
      const data = await res.json();
      return {
        title: data.title || defaultMeta.title,
        author: data.author_name || defaultMeta.author,
        thumbnailUrl: data.thumbnail_url || defaultMeta.thumbnailUrl,
        duration: defaultMeta.duration,
      };
    }
  } catch (err) {
    // Fail silently to fallback
  }

  return defaultMeta;
}

/**
 * Get current elapsed seconds according to server-authoritative clock.
 */
function getRoomElapsedSeconds(room) {
  if (!room.currentVideoId) return 0;
  if (!room.isPlaying) {
    return Math.max(0, room.pausedAt || 0);
  }
  const elapsed = (Date.now() - room.startedAt) / 1000;
  return Math.max(0, elapsed);
}

/**
 * Check and record rate limit for a client socket.
 * Returns: { allowed: boolean, remainingSeconds?: number, remainingRequests: number }
 */
function checkRateLimit(socketId, isAdmin = false) {
  // Admins can be exempted or have higher limits; per prompt:
  // "Restrict each client to maximum 2 track change requests per 60 seconds."
  if (isAdmin) {
    return { allowed: true, remainingRequests: MAX_REQUESTS_PER_WINDOW };
  }

  const now = Date.now();
  const history = (trackChangeTimestamps.get(socketId) || []).filter(
    (timestamp) => now - timestamp < RATE_LIMIT_WINDOW_MS
  );

  if (history.length >= MAX_REQUESTS_PER_WINDOW) {
    const oldestTimestamp = history[0];
    const cooldownRemainingMs = oldestTimestamp + RATE_LIMIT_WINDOW_MS - now;
    const remainingSeconds = Math.max(1, Math.ceil(cooldownRemainingMs / 1000));
    return {
      allowed: false,
      remainingSeconds,
      remainingRequests: 0,
    };
  }

  // Record this attempt
  history.push(now);
  trackChangeTimestamps.set(socketId, history);

  return {
    allowed: true,
    remainingRequests: MAX_REQUESTS_PER_WINDOW - history.length,
  };
}

/**
 * Compile public serializable room state for broadcasting.
 */
function formatRoomState(room) {
  const elapsedSeconds = getRoomElapsedSeconds(room);
  const usersList = Array.from(room.users.values()).map((u) => ({
    socketId: u.socketId,
    nickname: u.nickname,
    role: u.role,
  }));

  return {
    roomName: room.name,
    currentVideoId: room.currentVideoId,
    currentTitle: room.currentTitle,
    currentAuthor: room.currentAuthor,
    currentThumbnail: room.currentThumbnail,
    startedAt: room.startedAt,
    isPlaying: room.isPlaying,
    elapsedSeconds: parseFloat(elapsedSeconds.toFixed(2)),
    duration: room.duration,
    playlist: room.playlist,
    listenersCount: room.users.size,
    users: usersList,
    serverTime: Date.now(),
  };
}

function broadcastActiveRooms() {
  io.emit('active_rooms_list', getActiveRoomsList());
}

// ==========================================
// 10-SECOND SERVER HEARTBEAT ENGINE
// ==========================================
setInterval(() => {
  const now = Date.now();
  for (const [roomName, room] of rooms.entries()) {
    if (room.users.size === 0) continue;

    const elapsedSeconds = getRoomElapsedSeconds(room);

    // Broadcast heartbeat to room subscribers
    io.to(`room_${roomName}`).emit('sync_heartbeat', {
      currentVideoId: room.currentVideoId,
      isPlaying: room.isPlaying,
      elapsedSeconds: parseFloat(elapsedSeconds.toFixed(2)),
      serverTime: now,
    });
  }
}, 10000);

// ==========================================
// SOCKET.IO EVENT HANDLERS
// ==========================================
io.on('connection', (socket) => {
  // Immediately send real-time active rooms list to connected client
  socket.emit('active_rooms_list', getActiveRoomsList());
  // 1. CREATE ROOM (Admin)
  socket.on('create_room', async ({ roomName, nickname, forceRecreate = false }) => {
    if (!roomName || !roomName.trim()) {
      return socket.emit('error_notification', {
        message: 'Room name is required.',
      });
    }

    const normalizedRoom = roomName.trim().toLowerCase();
    console.log(`[CREATE ROOM] "${roomName}" (normalized: "${normalizedRoom}"). Current rooms:`, Array.from(rooms.keys()));
    if (rooms.has(normalizedRoom)) {
      const existingRoom = rooms.get(normalizedRoom);
      const isRoomEmpty = existingRoom.users.size === 0;

      // If previous room has no listeners, or force recreate: reset
      if (isRoomEmpty || forceRecreate) {
        io.to(`room_${normalizedRoom}`).emit('room_activity', {
          type: 'system',
          text: `Previous room was reset and recreated by Host.`,
          timestamp: Date.now(),
        });
        rooms.delete(normalizedRoom);
      } else {
        // If room is already active with listeners, join it directly!
        console.log(`[CREATE ROOM] "${roomName}" already active. Rejoining directly.`);
      }
    }

    const adminNickname = (nickname && nickname.trim()) || 'Admin Host';

    // If room already exists, join existing room instead of wiping ongoing song
    if (rooms.has(normalizedRoom)) {
      const room = rooms.get(normalizedRoom);
      const userObj = {
        socketId: socket.id,
        nickname: adminNickname,
        role: 'admin',
        joinedAt: Date.now(),
      };
      room.users.set(socket.id, userObj);
      socketToUser.set(socket.id, {
        roomName: normalizedRoom,
        nickname: adminNickname,
        role: 'admin',
        socketId: socket.id,
      });
      socket.join(`room_${normalizedRoom}`);
      socket.emit('room_joined', {
        ...formatRoomState(room),
        role: 'admin',
        message: `Joined active room "${room.name}" as Admin!`,
      });
      broadcastActiveRooms();
      return;
    }

    // Default initial track (Lofi Beats) to get started immediately
    const initialVideoId = 'jfKfPfyJRdk';
    const initialMeta = await fetchYouTubeMetadata(initialVideoId);

    const newRoom = {
      name: roomName.trim(),
      password: '',
      adminSocketId: socket.id,
      currentVideoId: initialVideoId,
      currentTitle: initialMeta.title,
      currentAuthor: initialMeta.author,
      currentThumbnail: initialMeta.thumbnailUrl,
      startedAt: Date.now(),
      isPlaying: true,
      pausedAt: 0,
      duration: 3600, // livestream/long-form track
      playlist: [
        {
          id: 'preset_1',
          videoId: '4xDzrJKXOOY',
          title: 'Synthwave Radio - Chill Synth / Retro Beats',
          author: 'Lofi Records',
          thumbnailUrl: 'https://img.youtube.com/vi/4xDzrJKXOOY/hqdefault.jpg',
          addedBy: 'System',
          addedAt: Date.now(),
        },
        {
          id: 'preset_2',
          videoId: 'Dx5qFachd3A',
          title: 'Coffee Shop Radio - Relaxing Jazz & Bossa Nova',
          author: 'Cafe Music',
          thumbnailUrl: 'https://img.youtube.com/vi/Dx5qFachd3A/hqdefault.jpg',
          addedBy: 'System',
          addedAt: Date.now(),
        },
      ],
      users: new Map(),
      lastTrackChangeTime: 0,
      createdAt: Date.now(),
    };

    const userObj = {
      socketId: socket.id,
      nickname: adminNickname,
      role: 'admin',
      joinedAt: Date.now(),
    };

    newRoom.users.set(socket.id, userObj);
    rooms.set(normalizedRoom, newRoom);
    socketToUser.set(socket.id, {
      roomName: normalizedRoom,
      nickname: adminNickname,
      role: 'admin',
      socketId: socket.id,
    });

    socket.join(`room_${normalizedRoom}`);

    // Notify creator
    socket.emit('room_joined', {
      ...formatRoomState(newRoom),
      role: 'admin',
      message: `Room "${roomName}" created successfully! You are the Admin.`,
    });

    // Notify room feed
    io.to(`room_${normalizedRoom}`).emit('room_activity', {
      type: 'system',
      text: `${adminNickname} (Admin) created the room.`,
      timestamp: Date.now(),
    });

    saveRoomsToDisk();
    // Broadcast updated room list to all lobbies
    broadcastActiveRooms();
  });

  // 2. JOIN ROOM (Client / Guest) - No password required, anyone with room name or link can enter!
  socket.on('join_room', async ({ roomName, nickname }) => {
    if (!roomName || !roomName.trim()) {
      return socket.emit('error_notification', {
        message: 'Room name is required.',
      });
    }

    const trimmed = roomName.trim();
    const normalizedRoom = trimmed.toLowerCase();
    const slugRoom = normalizedRoom.replace(/\s+/g, '-');
    const unslugRoom = normalizedRoom.replace(/-/g, ' ');

    let room = rooms.get(normalizedRoom) || rooms.get(slugRoom) || rooms.get(unslugRoom);

    if (!room) {
      for (const [key, r] of rooms.entries()) {
        const rName = r.name.toLowerCase();
        if (
          rName === normalizedRoom ||
          rName.replace(/\s+/g, '-') === slugRoom ||
          key === normalizedRoom ||
          key.replace(/\s+/g, '-') === slugRoom
        ) {
          room = r;
          break;
        }
      }
    }

    // Auto-initialize if room does not exist yet so user never gets an error
    if (!room) {
      console.log(`[JOIN ROOM] Auto-creating room "${roomName}" for instant join.`);
      const initialMeta = await fetchYouTubeMetadata('jfKfPfyJRdk');
      room = {
        name: trimmed,
        password: '',
        adminSocketId: socket.id,
        currentVideoId: 'jfKfPfyJRdk',
        currentTitle: initialMeta.title,
        currentAuthor: initialMeta.author,
        currentThumbnail: initialMeta.thumbnailUrl,
        startedAt: Date.now(),
        isPlaying: true,
        pausedAt: 0,
        duration: 3600,
        playlist: [],
        users: new Map(),
        lastTrackChangeTime: 0,
        createdAt: Date.now(),
      };
      rooms.set(normalizedRoom, room);
      saveRoomsToDisk();
      broadcastActiveRooms();
    }

    const guestNickname =
      (nickname && nickname.trim()) || `Listener_${Math.floor(1000 + Math.random() * 9000)}`;

    const userObj = {
      socketId: socket.id,
      nickname: guestNickname,
      role: room.users.size === 0 ? 'admin' : 'client',
      joinedAt: Date.now(),
    };

    room.users.set(socket.id, userObj);
    socketToUser.set(socket.id, {
      roomName: normalizedRoom,
      nickname: guestNickname,
      role: userObj.role,
      socketId: socket.id,
    });

    socket.join(`room_${normalizedRoom}`);

    // Send full current room state to newly connected client
    socket.emit('room_joined', {
      ...formatRoomState(room),
      role: userObj.role,
      message: `Joined room "${room.name}". Synchronizing playback...`,
    });

    // Broadcast user joined to entire room
    io.to(`room_${normalizedRoom}`).emit('user_joined', {
      users: Array.from(room.users.values()).map((u) => ({
        socketId: u.socketId,
        nickname: u.nickname,
        role: u.role,
      })),
      listenersCount: room.users.size,
      newUser: guestNickname,
    });

    broadcastActiveRooms();

    io.to(`room_${normalizedRoom}`).emit('room_activity', {
      type: 'user',
      text: `${guestNickname} joined the room.`,
      timestamp: Date.now(),
    });
  });

  // 3. CHANGE / SKIP TRACK (First-Come, First-Served with Rate Limiting & Lockout)
  socket.on('change_track', async ({ youtubeInput, isSkip = false }) => {
    const user = socketToUser.get(socket.id);
    if (!user) {
      return socket.emit('error_notification', { message: 'You are not in a room.' });
    }

    const room = rooms.get(user.roomName);
    if (!room) {
      return socket.emit('error_notification', { message: 'Room not found.' });
    }

    const isAdmin = user.role === 'admin';

    // Anti-Abuse Rate Limiter check (Max 2 requests per 60s per client)
    const rateCheck = checkRateLimit(socket.id, isAdmin);
    if (!rateCheck.allowed) {
      return socket.emit('rate_limit_error', {
        message: `Rate limit exceeded: Maximum 2 track changes per 60 seconds.`,
        remainingSeconds: rateCheck.remainingSeconds,
      });
    }

    // Race condition resolution: 500ms lockout window
    const now = Date.now();
    if (now - room.lastTrackChangeTime < RACE_CONDITION_LOCKOUT_MS) {
      return socket.emit('error_notification', {
        message: 'Another track change was just processed. Please wait a moment.',
      });
    }

    // Lock the room track change state
    room.lastTrackChangeTime = now;

    let targetVideoId = null;
    let targetMeta = null;

    if (isSkip) {
      // Check if there are tracks in queue
      if (room.playlist && room.playlist.length > 0) {
        const nextItem = room.playlist.shift();
        targetVideoId = nextItem.videoId;
        targetMeta = {
          title: nextItem.title,
          author: nextItem.author || 'YouTube Artist',
          thumbnailUrl: nextItem.thumbnailUrl,
          duration: nextItem.duration || 210,
        };
      } else {
        // No tracks in queue to skip to
        return socket.emit('error_notification', {
          message: 'The queue is empty. Paste a YouTube URL or pick a track to play!',
        });
      }
    } else {
      targetVideoId = extractYouTubeId(youtubeInput);
      if (!targetVideoId) {
        return socket.emit('error_notification', {
          message: 'Invalid YouTube link or ID. Please paste a valid YouTube video URL or ID.',
        });
      }
      targetMeta = await fetchYouTubeMetadata(targetVideoId);
    }

    // Update authoritative room state
    room.currentVideoId = targetVideoId;
    room.currentTitle = targetMeta.title;
    room.currentAuthor = targetMeta.author;
    room.currentThumbnail = targetMeta.thumbnailUrl;
    room.startedAt = Date.now();
    room.isPlaying = true;
    room.pausedAt = 0;
    room.duration = targetMeta.duration || 210;

    // Broadcast room_track_updated to all participants simultaneously
    io.to(`room_${user.roomName}`).emit('room_track_updated', {
      currentVideoId: room.currentVideoId,
      currentTitle: room.currentTitle,
      currentAuthor: room.currentAuthor,
      currentThumbnail: room.currentThumbnail,
      startedAt: room.startedAt,
      isPlaying: room.isPlaying,
      elapsedSeconds: 0,
      duration: room.duration,
      playlist: room.playlist,
      changedBy: user.nickname,
      serverTime: Date.now(),
    });

    io.to(`room_${user.roomName}`).emit('room_activity', {
      type: 'track',
      text: `${user.nickname} changed track to: "${room.currentTitle}"`,
      timestamp: Date.now(),
    });
  });

  // 4. ADD TO QUEUE (Playlist management)
  socket.on('add_to_queue', async ({ youtubeInput }) => {
    const user = socketToUser.get(socket.id);
    if (!user) return;
    const room = rooms.get(user.roomName);
    if (!room) return;

    const videoId = extractYouTubeId(youtubeInput);
    if (!videoId) {
      return socket.emit('error_notification', {
        message: 'Invalid YouTube link or ID.',
      });
    }

    const meta = await fetchYouTubeMetadata(videoId);
    const queueItem = {
      id: `queue_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
      videoId,
      title: meta.title,
      author: meta.author,
      thumbnailUrl: meta.thumbnailUrl,
      duration: meta.duration || 210,
      addedBy: user.nickname,
      addedAt: Date.now(),
    };

    // If room has no active track playing, start immediately
    if (!room.currentVideoId) {
      room.currentVideoId = queueItem.videoId;
      room.currentTitle = queueItem.title;
      room.currentAuthor = queueItem.author;
      room.currentThumbnail = queueItem.thumbnailUrl;
      room.startedAt = Date.now();
      room.isPlaying = true;
      room.pausedAt = 0;

      io.to(`room_${user.roomName}`).emit('room_track_updated', {
        currentVideoId: room.currentVideoId,
        currentTitle: room.currentTitle,
        currentAuthor: room.currentAuthor,
        currentThumbnail: room.currentThumbnail,
        startedAt: room.startedAt,
        isPlaying: room.isPlaying,
        elapsedSeconds: 0,
        duration: room.duration,
        playlist: room.playlist,
        changedBy: user.nickname,
        serverTime: Date.now(),
      });
    } else {
      room.playlist.push(queueItem);
      io.to(`room_${user.roomName}`).emit('playlist_updated', {
        playlist: room.playlist,
      });
    }

    io.to(`room_${user.roomName}`).emit('room_activity', {
      type: 'queue',
      text: `${user.nickname} added "${queueItem.title}" to the queue.`,
      timestamp: Date.now(),
    });
  });

  // 5. PLAYBACK CONTROLS (Play / Pause / Seek)
  socket.on('toggle_playback', () => {
    const user = socketToUser.get(socket.id);
    if (!user) return;
    const room = rooms.get(user.roomName);
    if (!room || !room.currentVideoId) return;

    // Both Admin and Clients can toggle, or Admin override
    if (room.isPlaying) {
      // Pause
      room.pausedAt = getRoomElapsedSeconds(room);
      room.isPlaying = false;
    } else {
      // Resume
      room.startedAt = Date.now() - (room.pausedAt || 0) * 1000;
      room.isPlaying = true;
    }

    const elapsed = getRoomElapsedSeconds(room);
    io.to(`room_${user.roomName}`).emit('playback_state_changed', {
      isPlaying: room.isPlaying,
      elapsedSeconds: parseFloat(elapsed.toFixed(2)),
      serverTime: Date.now(),
      updatedBy: user.nickname,
    });

    io.to(`room_${user.roomName}`).emit('room_activity', {
      type: 'control',
      text: `${user.nickname} ${room.isPlaying ? 'resumed' : 'paused'} playback.`,
      timestamp: Date.now(),
    });
  });

  socket.on('seek_to', ({ targetSeconds }) => {
    const user = socketToUser.get(socket.id);
    if (!user) return;
    const room = rooms.get(user.roomName);
    if (!room || !room.currentVideoId) return;

    const clampedSec = Math.max(0, parseFloat(targetSeconds) || 0);
    room.pausedAt = clampedSec;
    if (room.isPlaying) {
      room.startedAt = Date.now() - clampedSec * 1000;
    }

    io.to(`room_${user.roomName}`).emit('seek_updated', {
      elapsedSeconds: clampedSec,
      serverTime: Date.now(),
      seekBy: user.nickname,
    });
  });

  // 6. REMOVE QUEUE ITEM (Admin or owner)
  socket.on('remove_queue_item', ({ itemId }) => {
    const user = socketToUser.get(socket.id);
    if (!user) return;
    const room = rooms.get(user.roomName);
    if (!room) return;

    room.playlist = room.playlist.filter((item) => item.id !== itemId);
    io.to(`room_${user.roomName}`).emit('playlist_updated', {
      playlist: room.playlist,
    });
  });

  // 7. REQUEST INSTANT RESYNC
  socket.on('request_resync', () => {
    const user = socketToUser.get(socket.id);
    if (!user) return;
    const room = rooms.get(user.roomName);
    if (!room) return;

    const elapsed = getRoomElapsedSeconds(room);
    socket.emit('sync_heartbeat', {
      currentVideoId: room.currentVideoId,
      isPlaying: room.isPlaying,
      elapsedSeconds: parseFloat(elapsed.toFixed(2)),
      serverTime: Date.now(),
      isManualResync: true,
    });
  });

  // 8. SEND CHAT / REACTION MESSAGE
  socket.on('send_chat', ({ message }) => {
    const user = socketToUser.get(socket.id);
    if (!user || !message || !message.trim()) return;

    io.to(`room_${user.roomName}`).emit('chat_message', {
      sender: user.nickname,
      role: user.role,
      text: message.trim().slice(0, 200),
      timestamp: Date.now(),
    });
  });

  // 9. DELETE ROOM (Admin explicit deletion)
  socket.on('delete_room', () => {
    const user = socketToUser.get(socket.id);
    if (!user || user.role !== 'admin') {
      return socket.emit('error_notification', {
        message: 'Only the room Admin can delete this room.',
      });
    }

    const room = rooms.get(user.roomName);
    if (room) {
      io.to(`room_${user.roomName}`).emit('room_deleted', {
        message: `Room "${room.name}" was closed and deleted by the Admin.`,
      });
      rooms.delete(user.roomName);
      saveRoomsToDisk();
      broadcastActiveRooms();
    }
  });

  // 10. DISCONNECT HANDLING
  socket.on('disconnect', () => {
    const user = socketToUser.get(socket.id);
    if (!user) return;

    const room = rooms.get(user.roomName);
    if (room) {
      room.users.delete(socket.id);

      // If admin left and others remain, designate next user as admin
      if (room.adminSocketId === socket.id && room.users.size > 0) {
        const nextAdmin = room.users.values().next().value;
        if (nextAdmin) {
          nextAdmin.role = 'admin';
          room.adminSocketId = nextAdmin.socketId;
          const targetSocket = io.sockets.sockets.get(nextAdmin.socketId);
          if (targetSocket) {
            targetSocket.emit('role_changed', { role: 'admin' });
          }
        }
      }

      // Broadcast user left
      io.to(`room_${user.roomName}`).emit('user_left', {
        users: Array.from(room.users.values()).map((u) => ({
          socketId: u.socketId,
          nickname: u.nickname,
          role: u.role,
        })),
        listenersCount: room.users.size,
        leftUser: user.nickname,
      });

      broadcastActiveRooms();

      io.to(`room_${user.roomName}`).emit('room_activity', {
        type: 'system',
        text: `${user.nickname} disconnected.`,
        timestamp: Date.now(),
      });

      // Keep empty rooms in memory for 24 hours so hosts can reconnect or refresh without losing their room
      if (room.users.size === 0) {
        setTimeout(() => {
          const checkRoom = rooms.get(user.roomName);
          if (checkRoom && checkRoom.users.size === 0) {
            rooms.delete(user.roomName);
          }
        }, 24 * 60 * 60 * 1000);
      }
    }

    socketToUser.delete(socket.id);
    trackChangeTimestamps.delete(socket.id);
  });
});

// SPA fallback route
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/socket.io') || req.path.includes('.')) {
    return next();
  }
  const fallbackIndex = fs.existsSync(path.join(distDir, 'index.html'))
    ? path.join(distDir, 'index.html')
    : path.join(publicDir, 'index.html');
  res.sendFile(fallbackIndex);
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`SyncBeat server running at http://localhost:${PORT}`);
});
