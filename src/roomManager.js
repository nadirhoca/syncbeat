/**
 * Core Server-Authoritative Room Synchronization Manager
 * Single source of truth for room playback states, queues, listener roles,
 * and JSON disk persistence at data/rooms.json.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { fetchVideoMetadata } = require('./youtubeHelper');

const DATA_DIR = path.join(__dirname, '..', 'data');
const DATA_FILE = path.join(DATA_DIR, 'rooms.json');

// Default Seed Streams as requested
const SEED_ROOMS = [
  {
    name: 'Lofi Lounge',
    normalizedName: 'lofi-lounge',
    currentVideoId: 'jfKfPfyJRdk',
    currentTitle: 'Lofi Hip Hop Radio - Beats to Relax/Study to',
    currentAuthor: 'Lofi Girl',
    currentThumbnail: 'https://img.youtube.com/vi/jfKfPfyJRdk/hqdefault.jpg',
    duration: 0,
    queue: [
      {
        id: 'seed-q-1',
        videoId: '4xDzrJKXOOY',
        title: 'Synthwave Radio - Chill Synth / Retro Beats',
        author: 'Lofi Girl',
        thumbnailUrl: 'https://img.youtube.com/vi/4xDzrJKXOOY/hqdefault.jpg',
        duration: 0,
        addedBy: 'SyncBeat Curator'
      },
      {
        id: 'seed-q-2',
        videoId: 'Dx5qFachd3A',
        title: 'Relaxing Jazz Piano Radio - Sweet Bossa Nova',
        author: 'Cafe Music BGM',
        thumbnailUrl: 'https://img.youtube.com/vi/Dx5qFachd3A/hqdefault.jpg',
        duration: 0,
        addedBy: 'SyncBeat Curator'
      }
    ]
  },
  {
    name: 'Synthwave Radio',
    normalizedName: 'synthwave-radio',
    currentVideoId: '4xDzrJKXOOY',
    currentTitle: 'Synthwave Radio - Chill synth / retro beats',
    currentAuthor: 'Lofi Girl',
    currentThumbnail: 'https://img.youtube.com/vi/4xDzrJKXOOY/hqdefault.jpg',
    duration: 0,
    queue: []
  },
  {
    name: 'Cafe Jazz',
    normalizedName: 'cafe-jazz',
    currentVideoId: 'Dx5qFachd3A',
    currentTitle: 'Relaxing Jazz Piano Radio - Sweet Bossa Nova & Jazz',
    currentAuthor: 'Cafe Music BGM',
    currentThumbnail: 'https://img.youtube.com/vi/Dx5qFachd3A/hqdefault.jpg',
    duration: 0,
    queue: []
  },
  {
    name: 'dene',
    normalizedName: 'dene',
    currentVideoId: 'Dx5qFachd3A',
    currentTitle: 'Cafe Jazz Beats - Ambient Synchronized Stream',
    currentAuthor: 'Dene Lounge',
    currentThumbnail: 'https://img.youtube.com/vi/Dx5qFachd3A/hqdefault.jpg',
    duration: 0,
    queue: []
  }
];

class RoomManager {
  constructor() {
    this.rooms = new Map(); // normalizedName -> Room object
    this.saveTimeout = null;
    this.init();
  }

  /**
   * Helper to normalize room names for URL slugs & lookup
   */
  static normalize(name) {
    if (!name || typeof name !== 'string') return '';
    return name
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, '-')
      .replace(/^-+|-+$/g, '');
  }

  init() {
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }

    let loaded = false;
    if (fs.existsSync(DATA_FILE)) {
      try {
        const raw = fs.readFileSync(DATA_FILE, 'utf8');
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed) && parsed.length > 0) {
          for (const item of parsed) {
            this.instantiateRoom(item);
          }
          loaded = true;
        }
      } catch (err) {
        console.error('[RoomManager] Failed reading rooms.json, seeding defaults:', err.message);
      }
    }

    if (!loaded) {
      // Seed default rooms
      const now = Date.now();
      for (const seed of SEED_ROOMS) {
        this.instantiateRoom({
          ...seed,
          startedAt: now,
          isPlaying: true,
          pausedAtSec: 0,
          createdAt: now
        });
      }
      this.saveToDiskSync();
    }
  }

  instantiateRoom(data) {
    const norm = RoomManager.normalize(data.name || data.normalizedName);
    if (!norm) return null;

    let startedAt = Number(data.startedAt) || Date.now();
    // Safety check: if startedAt is far in the past (> 24 hours) or invalid, reset to now
    // to avoid astronomical elapsed seconds that break player decoders
    if (Date.now() - startedAt > 86400000 || startedAt <= 0) {
      startedAt = Date.now();
    }

    const room = {
      name: data.name || norm,
      normalizedName: norm,
      currentVideoId: data.currentVideoId || 'jfKfPfyJRdk',
      currentTitle: data.currentTitle || 'Lofi Beats',
      currentAuthor: data.currentAuthor || 'SyncBeat Stream',
      currentThumbnail: data.currentThumbnail || `https://img.youtube.com/vi/${data.currentVideoId || 'jfKfPfyJRdk'}/hqdefault.jpg`,
      startedAt,
      isPlaying: typeof data.isPlaying === 'boolean' ? data.isPlaying : true,
      pausedAtSec: Number(data.pausedAtSec) || 0,
      duration: Number(data.duration) || 0,
      queue: Array.isArray(data.queue) ? data.queue : [],
      createdAt: data.createdAt || Date.now(),
      listeners: new Map() // socketId -> { id, nickname, role, joinedAt }
    };

    this.rooms.set(norm, room);
    return room;
  }

  saveDebounced() {
    if (this.saveTimeout) clearTimeout(this.saveTimeout);
    this.saveTimeout = setTimeout(() => {
      this.saveToDiskSync();
    }, 500);
  }

  saveToDiskSync() {
    try {
      const serializable = Array.from(this.rooms.values()).map(r => ({
        name: r.name,
        normalizedName: r.normalizedName,
        currentVideoId: r.currentVideoId,
        currentTitle: r.currentTitle,
        currentAuthor: r.currentAuthor,
        currentThumbnail: r.currentThumbnail,
        startedAt: r.startedAt,
        isPlaying: r.isPlaying,
        pausedAtSec: r.pausedAtSec,
        duration: r.duration,
        queue: r.queue,
        createdAt: r.createdAt
      }));
      fs.writeFileSync(DATA_FILE, JSON.stringify(serializable, null, 2), 'utf8');
    } catch (err) {
      console.error('[RoomManager] Error saving rooms to disk:', err.message);
    }
  }

  getRoom(identifier) {
    if (!identifier) return null;
    const norm = RoomManager.normalize(identifier);
    return this.rooms.get(norm) || null;
  }

  getAllRooms() {
    return Array.from(this.rooms.values());
  }

  /**
   * Pre-rendered showcase summary of active rooms
   */
  getPublicRoomsSummary() {
    return Array.from(this.rooms.values()).map(r => ({
      name: r.name,
      normalizedName: r.normalizedName,
      currentVideoId: r.currentVideoId,
      currentTitle: r.currentTitle,
      currentAuthor: r.currentAuthor,
      currentThumbnail: r.currentThumbnail,
      isPlaying: r.isPlaying,
      listenerCount: r.listeners.size,
      queueCount: r.queue.length
    }));
  }

  /**
   * Create a new room
   */
  async createRoom(name, initialVideoId = 'jfKfPfyJRdk') {
    const norm = RoomManager.normalize(name);
    if (!norm) throw new Error('Invalid room name');

    if (this.rooms.has(norm)) {
      return this.rooms.get(norm);
    }

    const metadata = await fetchVideoMetadata(initialVideoId);
    const now = Date.now();
    const newRoom = this.instantiateRoom({
      name: name.trim(),
      normalizedName: norm,
      currentVideoId: initialVideoId,
      currentTitle: metadata.title,
      currentAuthor: metadata.author,
      currentThumbnail: metadata.thumbnailUrl,
      startedAt: now,
      isPlaying: true,
      pausedAtSec: 0,
      duration: 0,
      queue: [],
      createdAt: now
    });

    this.saveDebounced();
    return newRoom;
  }

  /**
   * Calculate current elapsed playback position according to Server Authority Contract
   */
  calculateCurrentElapsed(room) {
    if (!room) return 0;
    if (room.isPlaying) {
      let elapsed = (Date.now() - room.startedAt) / 1000;
      if (room.duration > 0 && elapsed > room.duration) {
        elapsed = elapsed % room.duration;
      }
      return Math.max(0, elapsed);
    } else {
      return Math.max(0, room.pausedAtSec);
    }
  }

  /**
   * Returns authoritative synchronization payload for client
   */
  getSyncPayload(room) {
    if (!room) return null;
    const currentElapsedSec = this.calculateCurrentElapsed(room);
    return {
      name: room.name,
      normalizedName: room.normalizedName,
      currentVideoId: room.currentVideoId,
      currentTitle: room.currentTitle,
      currentAuthor: room.currentAuthor,
      currentThumbnail: room.currentThumbnail,
      isPlaying: room.isPlaying,
      serverTimestamp: Date.now(),
      currentElapsedSec,
      duration: room.duration,
      queue: room.queue,
      listeners: Array.from(room.listeners.values())
    };
  }

  /**
   * Register a listener to a room
   */
  joinRoom(roomIdentifier, socketId, nickname = 'Anonymous') {
    let room = this.getRoom(roomIdentifier);
    if (!room) {
      // Auto-create room if it does not exist yet
      const norm = RoomManager.normalize(roomIdentifier);
      const cleanName = roomIdentifier.trim() || 'Music Room';
      room = this.instantiateRoom({
        name: cleanName,
        normalizedName: norm,
        currentVideoId: 'jfKfPfyJRdk',
        currentTitle: 'Lofi Hip Hop Radio',
        currentAuthor: 'Lofi Girl',
        currentThumbnail: 'https://img.youtube.com/vi/jfKfPfyJRdk/hqdefault.jpg',
        startedAt: Date.now(),
        isPlaying: true,
        pausedAtSec: 0,
        duration: 0,
        queue: [],
        createdAt: Date.now()
      });
      this.saveDebounced();
    }

    // Role assignment: first listener becomes admin
    const isFirst = room.listeners.size === 0;
    const role = isFirst ? 'admin' : 'client';

    const listener = {
      id: socketId,
      nickname: (nickname && nickname.trim()) || `User-${socketId.slice(0, 4)}`,
      role,
      joinedAt: Date.now()
    };

    room.listeners.set(socketId, listener);
    return { room, listener };
  }

  /**
   * Remove listener from room and promote next admin if needed
   */
  leaveRoom(socketId) {
    for (const room of this.rooms.values()) {
      if (room.listeners.has(socketId)) {
        const leavingListener = room.listeners.get(socketId);
        room.listeners.delete(socketId);

        let newAdmin = null;
        if (leavingListener.role === 'admin' && room.listeners.size > 0) {
          // Promote next listener to admin
          const nextSocketId = room.listeners.keys().next().value;
          newAdmin = room.listeners.get(nextSocketId);
          newAdmin.role = 'admin';
        }

        return { room, leavingListener, newAdmin };
      }
    }
    return null;
  }

  /**
   * Play playback (Server Authority)
   */
  play(room) {
    if (!room.isPlaying) {
      room.isPlaying = true;
      room.startedAt = Date.now() - (room.pausedAtSec * 1000);
      this.saveDebounced();
    }
    return this.getSyncPayload(room);
  }

  /**
   * Pause playback (Server Authority)
   */
  pause(room) {
    if (room.isPlaying) {
      let elapsed = (Date.now() - room.startedAt) / 1000;
      if (room.duration > 0 && elapsed > room.duration) {
        elapsed = elapsed % room.duration;
      }
      room.pausedAtSec = Math.max(0, elapsed);
      room.isPlaying = false;
      this.saveDebounced();
    }
    return this.getSyncPayload(room);
  }

  /**
   * Seek playback (Server Authority)
   */
  seek(room, targetSec) {
    const sec = Math.max(0, Number(targetSec) || 0);
    room.pausedAtSec = sec;
    room.startedAt = Date.now() - (sec * 1000);
    this.saveDebounced();
    return this.getSyncPayload(room);
  }

  /**
   * Set new track immediately
   */
  setTrack(room, { videoId, title, author, thumbnailUrl, duration }) {
    room.currentVideoId = videoId;
    room.currentTitle = title || `Track (${videoId})`;
    room.currentAuthor = author || 'Artist';
    room.currentThumbnail = thumbnailUrl || `https://img.youtube.com/vi/${videoId}/hqdefault.jpg`;
    room.startedAt = Date.now();
    room.pausedAtSec = 0;
    room.isPlaying = true;
    room.duration = Number(duration) || 0;

    this.saveDebounced();
    return this.getSyncPayload(room);
  }

  /**
   * Add track to queue
   */
  addToQueue(room, { videoId, title, author, thumbnailUrl, duration, addedBy }) {
    const track = {
      id: crypto.randomUUID(),
      videoId,
      title: title || `Track (${videoId})`,
      author: author || 'Artist',
      thumbnailUrl: thumbnailUrl || `https://img.youtube.com/vi/${videoId}/hqdefault.jpg`,
      duration: Number(duration) || 0,
      addedBy: addedBy || 'Anonymous',
      addedAt: Date.now()
    };
    room.queue.push(track);
    this.saveDebounced();
    return track;
  }

  /**
   * Remove track from queue
   */
  removeFromQueue(room, trackId) {
    const index = room.queue.findIndex(t => t.id === trackId);
    if (index !== -1) {
      const removed = room.queue.splice(index, 1)[0];
      this.saveDebounced();
      return removed;
    }
    return null;
  }

  /**
   * Skip to next track in queue
   */
  skipTrack(room) {
    if (room.queue.length > 0) {
      const nextTrack = room.queue.shift();
      return this.setTrack(room, nextTrack);
    } else {
      // Loop current track or restart from 0
      room.startedAt = Date.now();
      room.pausedAtSec = 0;
      room.isPlaying = true;
      this.saveDebounced();
      return this.getSyncPayload(room);
    }
  }

  /**
   * Update known duration reported by player
   */
  updateDuration(room, duration) {
    const dur = Number(duration);
    if (!isNaN(dur) && dur > 0 && room.duration !== dur) {
      room.duration = dur;
      this.saveDebounced();
    }
  }
}

module.exports = new RoomManager();
