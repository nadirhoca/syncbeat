/**
 * Verification Test for Room Enter / Exit & Switching Mechanics
 */

const http = require('http');
const express = require('express');
const { Server } = require('socket.io');
const { io } = require('socket.io-client');
const assert = require('assert');

const roomManager = require('../src/roomManager');
const SlidingWindowRateLimiter = require('../src/rateLimiter');

async function runRoomTests() {
  console.log('🧪 Running Room Enter / Exit & Switch Integration Test...\n');

  // Start a local test server
  const app = express();
  const server = http.createServer(app);
  const ioServer = new Server(server, { cors: { origin: '*' } });
  const actionRateLimiter = new SlidingWindowRateLimiter(5, 15000);

  ioServer.on('connection', (socket) => {
    let currentRoom = null;
    let currentListener = null;

    function handleLeave() {
      if (!currentRoom) return;
      const leavingRoom = currentRoom;
      const socketRoomId = `room:${leavingRoom.normalizedName}`;
      socket.leave(socketRoomId);

      const result = roomManager.leaveRoom(socket.id);
      if (result) {
        const { room, leavingListener, newAdmin } = result;
        ioServer.to(socketRoomId).emit('listeners:update', {
          listeners: Array.from(room.listeners.values())
        });
        if (newAdmin) {
          ioServer.to(newAdmin.id).emit('role:promoted', { role: 'admin' });
        }
      }
      currentRoom = null;
      currentListener = null;
    }

    socket.on('join:room', ({ roomName, nickname }) => {
      if (!roomName) return;
      const cleanName = typeof roomName === 'string' ? decodeURIComponent(roomName).trim() : '';
      const norm = roomManager.normalize(cleanName);

      if (currentRoom && currentRoom.normalizedName === norm) {
        socket.emit('room:joined', {
          syncState: roomManager.getSyncPayload(currentRoom),
          you: currentListener
        });
        return;
      }

      if (currentRoom) {
        handleLeave();
      }

      const { room, listener } = roomManager.joinRoom(cleanName, socket.id, nickname);
      currentRoom = room;
      currentListener = listener;

      const socketRoomId = `room:${room.normalizedName}`;
      socket.join(socketRoomId);

      socket.emit('room:joined', {
        syncState: roomManager.getSyncPayload(room),
        you: listener
      });

      ioServer.to(socketRoomId).emit('listeners:update', {
        listeners: Array.from(room.listeners.values())
      });
    });

    socket.on('leave:room', () => {
      handleLeave();
      socket.emit('room:left');
    });

    socket.on('chat:send', ({ text }) => {
      if (!currentRoom) return;
      ioServer.to(`room:${currentRoom.normalizedName}`).emit('chat:message', {
        sender: currentListener ? currentListener.nickname : 'Anon',
        text,
        room: currentRoom.normalizedName
      });
    });

    socket.on('disconnect', () => {
      handleLeave();
    });
  });

  const TEST_PORT = 3456;
  await new Promise((res) => server.listen(TEST_PORT, res));

  try {
    const c1 = io(`http://localhost:${TEST_PORT}`, { reconnection: false });
    const c2 = io(`http://localhost:${TEST_PORT}`, { reconnection: false });

    await Promise.all([
      new Promise(r => c1.on('connect', r)),
      new Promise(r => c2.on('connect', r))
    ]);
    console.log('  ✔ Clients connected to test server');

    // 1. Client 1 joins test-room-a -> Admin
    const p1 = new Promise(resolve => {
      c1.once('room:joined', ({ you, syncState }) => {
        assert.strictEqual(you.role, 'admin');
        assert.strictEqual(syncState.normalizedName, 'test-room-a');
        resolve();
      });
    });
    c1.emit('join:room', { roomName: 'Test Room A', nickname: 'Alice' });
    await p1;
    console.log('  ✔ Alice joined "Test Room A" as Admin');

    // 2. Client 2 joins test-room-a -> Listener
    const p2 = new Promise(resolve => {
      c2.once('room:joined', ({ you }) => {
        assert.strictEqual(you.role, 'client');
        resolve();
      });
    });
    c2.emit('join:room', { roomName: 'Test Room A', nickname: 'Bob' });
    await p2;
    console.log('  ✔ Bob joined "Test Room A" as regular Listener');

    // 3. Alice leaves -> Bob gets promoted to Admin
    const pPromote = new Promise(resolve => {
      c2.once('role:promoted', ({ role }) => {
        assert.strictEqual(role, 'admin');
        resolve();
      });
    });
    c1.emit('leave:room');
    await pPromote;
    console.log('  ✔ Alice left; Bob was promoted to Admin automatically');

    // 4. Bob switches to Test Room B
    const pSwitch = new Promise(resolve => {
      c2.once('room:joined', ({ you, syncState }) => {
        assert.strictEqual(syncState.normalizedName, 'test-room-b');
        resolve();
      });
    });
    c2.emit('join:room', { roomName: 'Test Room B', nickname: 'Bob' });
    await pSwitch;
    console.log('  ✔ Bob switched cleanly to "Test Room B"');

    // 5. Verify Bob does NOT receive messages sent to Room A
    let crossMessageReceived = false;
    c2.on('chat:message', (msg) => {
      if (msg.room === 'test-room-a') {
        crossMessageReceived = true;
      }
    });

    // Alice rejoins Room A and sends a message
    await new Promise(r => {
      c1.once('room:joined', r);
      c1.emit('join:room', { roomName: 'Test Room A', nickname: 'Alice' });
    });
    c1.emit('chat:send', { text: 'Hello Room A only!' });

    await new Promise(r => setTimeout(r, 400));
    assert.strictEqual(crossMessageReceived, false, 'Bob should NOT receive messages from Room A after switching!');
    console.log('  ✔ Socket room channel unsubscription verified (no cross-room message bleed)');

    // 6. Bob explicitly leaves Room B
    const pLeft = new Promise(resolve => {
      c2.once('room:left', resolve);
    });
    c2.emit('leave:room');
    await pLeft;
    console.log('  ✔ Bob cleanly left Room B and received "room:left" confirmation');

    c1.disconnect();
    c2.disconnect();
    console.log('\n🎉 ALL ROOM ENTER / EXIT / SWITCH TESTS PASSED!\n');
  } finally {
    server.close();
  }
}

runRoomTests().catch((err) => {
  console.error('❌ Test failed:', err);
  process.exit(1);
});
