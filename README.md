# SyncBeat - Real-Time Synchronized Music Room

SyncBeat is a full-stack real-time synchronized music room web application powered by **Node.js (Express + Socket.io)** for the backend and **vanilla HTML5, CSS3, and JavaScript** on the frontend, integrating the **YouTube IFrame Player API**.

---

## Quick Start & Setup Instructions

### 1. Installation
Install project dependencies:
```bash
npm install
```

### 2. Run the Development Server
Start the Express + Socket.io server with hot TypeScript/JavaScript execution:
```bash
npm run dev
```
The server will boot on port `3000`:
```
SyncBeat server running at http://localhost:3000
```
Open [http://localhost:3000](http://localhost:3000) in your browser.

### 3. Production Deployment
Run the production Node.js server:
```bash
npm run build
npm start
```

---

## Architecture & Core Features

### 1. User Roles & Authentication
- **Admin Host**:
  - Creates a room by choosing a custom Room Name and Room Password.
  - Controls initial playback and holds administrative override permissions (scrub/seek playback for all clients, skip tracks, remove items, clear queue).
- **Guest Client**:
  - Joins an existing room by entering the Room Name and matching Room Password.
- **Browser Audio Unlock**:
  - Tapping "Join Room" or "Create Room" executes a user gesture that primes and unlocks programmatic audio playback in mobile browsers (iOS Safari, Android Chrome).
  - An inline banner also provides a one-tap unmute option if autoplay policies restrict playback.

### 2. Synchronization Engine (Server-Authoritative)
- The server does not stream raw video/audio bytes; it manages authoritative room playback state and broadcast timing:
  - `currentVideoId`: 11-character YouTube video ID
  - `startedAt`: Epoch timestamp (ms) when playback began
  - `isPlaying`: Playback state flag
  - `playlist`: Array of queued tracks
- Elapsed playback time is calculated with:
  $$\text{elapsedSeconds} = \frac{\text{Date.now()} - \text{startedAt}}{1000}$$
- **10-Second Server Heartbeat**:
  - The server emits `sync_heartbeat` every 10 seconds to all connected room sockets.
  - Clients compare their local player timestamp with `elapsedSeconds`. If drift exceeds $\pm 1.0\text{s}$, `player.seekTo(elapsedSeconds, true)` automatically realigns them.

### 3. Track Change Logic & Race Condition Resolution
- Track changes are handled **first-come, first-served** based on server arrival time (`Date.now()`).
- A **500 ms lockout window** rejects conflicting concurrent requests with a descriptive notification.
- Updates are broadcast immediately to all participants via `room_track_updated`.

### 4. Anti-Abuse & Sliding-Window Rate Limiter
- Every client socket is tracked using a sliding-window rate limiter:
  - **Limit**: Maximum 2 track change requests per 60 seconds per socket.
  - If a client exceeds this threshold, the request is blocked and an error notification is emitted with the exact remaining cooldown seconds.
  - The client UI displays an active countdown timer on the rate-limit pill.

---

## File Structure

```
├── server.js              # Express + Socket.io server, rate limiter, sync math
├── server.ts              # Full-stack server entry point (runs with tsx)
├── public/
│   ├── index.html         # Main dashboard & lobby interface
│   ├── style.css          # Responsive cyber-lounge theme
│   └── app.js             # YouTube IFrame API integration & socket listeners
├── package.json           # Dependencies and run scripts
└── metadata.json          # Application metadata
```
