/**
 * Integration Socket.io Client Test
 * Simulates real socket clients interacting with the SyncBeat server.
 */

const { io } = require('socket.io-client');
const assert = require('assert');

async function testSockets() {
  console.log('⚡ Starting Socket.io Integration Tests...\n');

  const client1 = io('http://localhost:3000', { reconnection: false });

  await new Promise((resolve, reject) => {
    client1.on('connect', resolve);
    client1.on('connect_error', reject);
  });
  console.log('  ✔ Client 1 connected to server via WebSocket');

  // 1. Test Joining a Room
  const joinPromise = new Promise((resolve) => {
    client1.on('room:joined', (payload) => {
      assert(payload.syncState, 'Should have syncState');
      assert.strictEqual(payload.you.role, 'admin', 'First client in room should be admin');
      assert.strictEqual(payload.syncState.name, 'Lofi Lounge');
      console.log('  ✔ Client 1 joined "Lofi Lounge" and received Authoritative Sync Payload with Admin role');
      resolve(payload);
    });
  });

  client1.emit('join:room', { roomName: 'Lofi Lounge', nickname: 'TestAdmin' });
  await joinPromise;

  // 2. Test Playback Toggle
  const togglePromise = new Promise((resolve) => {
    client1.on('room:sync', (state) => {
      if (state.isPlaying === false) {
        console.log('  ✔ Playback toggle received: isPlaying is now false');
        resolve(state);
      }
    });
  });
  client1.emit('playback:toggle', { isPlaying: false });
  await togglePromise;

  // 3. Test Add to Queue
  const queuePromise = new Promise((resolve) => {
    client1.on('queue:update', ({ queue }) => {
      const added = queue.find(q => q.videoId === '5qap5aO4i9A');
      if (added) {
        console.log(`  ✔ Successfully added track "${added.title}" to queue`);
        resolve(queue);
      }
    });
  });
  client1.emit('track:add_queue', { input: '5qap5aO4i9A' });
  await queuePromise;

  // 4. Test Sliding-Window Rate Limiter Anti-Abuse
  console.log('  Testing Anti-Abuse Rate Limiter (attempting rapid actions)...');
  const rateLimitPromise = new Promise((resolve) => {
    client1.on('rate:limit_error', (err) => {
      assert(err.cooldownRemainingSec > 0, 'Should return cooldownRemainingSec');
      console.log(`  ✔ Anti-Abuse triggered as expected: "${err.message}" (${err.cooldownRemainingSec}s cooldown)`);
      resolve(err);
    });
  });

  // Action 1 (already consumed by toggle above), now send 2 more rapidly to exceed 2 actions/15s
  client1.emit('playback:toggle', { isPlaying: true });
  client1.emit('playback:skip');
  await rateLimitPromise;

  // 5. Test Live Chat
  const chatPromise = new Promise((resolve) => {
    client1.on('chat:message', (msg) => {
      assert.strictEqual(msg.text, 'Hello SyncBeat!');
      assert.strictEqual(msg.sender, 'TestAdmin');
      console.log('  ✔ Real-time chat message broadcast received');
      resolve(msg);
    });
  });
  client1.emit('chat:send', { text: 'Hello SyncBeat!' });
  await chatPromise;

  client1.disconnect();
  console.log('\n=============================================');
  console.log('🎉 ALL SOCKET.IO INTEGRATION TESTS PASSED!');
  console.log('=============================================\n');
  process.exit(0);
}

testSockets().catch(err => {
  console.error('❌ Socket test failed:', err);
  process.exit(1);
});
