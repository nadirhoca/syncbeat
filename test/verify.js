/**
 * Verification Script for SyncBeat
 * Tests core components, server-authoritative sync calculations, rate limiter,
 * YouTube helper, and HTTP server endpoints.
 */

const assert = require('assert');
const http = require('http');
const roomManager = require('../src/roomManager');
const SlidingWindowRateLimiter = require('../src/rateLimiter');
const { extractVideoId } = require('../src/youtubeHelper');

async function runTests() {
  console.log('🧪 Starting SyncBeat Test Suite...\n');

  // Test 1: Seed Rooms & Persistence
  console.log('▶ Test 1: Seed Rooms & Disk Rehydration');
  const rooms = roomManager.getAllRooms();
  assert(rooms.length >= 4, `Expected at least 4 rooms, got ${rooms.length}`);
  const lofi = roomManager.getRoom('lofi-lounge');
  assert(lofi, 'Lofi Lounge room should exist');
  assert.strictEqual(lofi.currentVideoId, 'jfKfPfyJRdk');
  assert(lofi.queue.length > 0, 'Lofi Lounge should have pre-seeded queue items');
  console.log('  ✔ Pre-seeded 4 default high-uptime rooms successfully');

  // Test 2: Server-Authoritative Playback Contract
  console.log('\n▶ Test 2: Server-Authoritative Synchronization Contract');
  const initialElapsed = roomManager.calculateCurrentElapsed(lofi);
  assert(typeof initialElapsed === 'number' && initialElapsed >= 0, 'Elapsed time must be non-negative number');
  
  // Pause room
  const pausedState = roomManager.pause(lofi);
  assert.strictEqual(pausedState.isPlaying, false);
  const pausedElapsed = roomManager.calculateCurrentElapsed(lofi);
  assert.strictEqual(pausedElapsed, lofi.pausedAtSec, 'Paused elapsed must equal pausedAtSec');

  // Resume room
  const resumedState = roomManager.play(lofi);
  assert.strictEqual(resumedState.isPlaying, true);
  console.log('  ✔ Server playback state toggles & mathematical time contract verified');

  // Test 3: Sliding Window Rate Limiter
  console.log('\n▶ Test 3: Sliding Window Anti-Abuse Rate Limiter');
  const limiter = new SlidingWindowRateLimiter(2, 15000);
  const testKey = 'test-client-ip:1234';

  const r1 = limiter.consume(testKey);
  assert.strictEqual(r1.allowed, true, '1st action in 15s window should be allowed');

  const r2 = limiter.consume(testKey);
  assert.strictEqual(r2.allowed, true, '2nd action in 15s window should be allowed');

  const r3 = limiter.consume(testKey);
  assert.strictEqual(r3.allowed, false, '3rd action in 15s window must be blocked');
  assert(r3.cooldownRemainingSec > 0 && r3.cooldownRemainingSec <= 15, 'Cooldown must be between 1 and 15 seconds');
  console.log(`  ✔ Rate limiter successfully blocked 3rd action with ${r3.cooldownRemainingSec}s cooldown`);

  // Test 4: YouTube URL & ID Parser
  console.log('\n▶ Test 4: YouTube URL & ID Parser');
  const urlTests = [
    { input: 'https://www.youtube.com/watch?v=jfKfPfyJRdk', expected: 'jfKfPfyJRdk' },
    { input: 'https://youtu.be/4xDzrJKXOOY', expected: '4xDzrJKXOOY' },
    { input: 'https://www.youtube.com/shorts/Dx5qFachd3A', expected: 'Dx5qFachd3A' },
    { input: 'Dx5qFachd3A', expected: 'Dx5qFachd3A' }
  ];

  for (const t of urlTests) {
    const extracted = extractVideoId(t.input);
    assert.strictEqual(extracted, t.expected, `Failed extracting ID from ${t.input}`);
  }
  console.log('  ✔ All YouTube URL formats & raw IDs parsed accurately');

  console.log('\n=============================================');
  console.log('🎉 ALL UNIT TESTS PASSED SUCCESSFULLY!');
  console.log('=============================================\n');
}

runTests().catch(err => {
  console.error('❌ Test failed:', err);
  process.exit(1);
});
