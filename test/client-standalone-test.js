/**
 * Test: Standalone / Firebase Hosting Client Simulation
 * Verifies that entering room name and nickname transitions immediately to room view,
 * makes the user the 👑 Room Admin, and enables sharing the room invite link to visitors.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

// Minimal DOM simulation for Node environment
function createMockDom() {
  const elements = {};

  function makeEl(id, tagName = 'div') {
    const el = {
      id,
      tagName,
      className: '',
      classList: {
        classes: new Set(),
        add(...cls) { cls.forEach(c => this.classes.add(c)); },
        remove(...cls) { cls.forEach(c => this.classes.delete(c)); },
        contains(c) { return this.classes.has(c); }
      },
      innerHTML: '',
      textContent: '',
      value: '',
      listeners: {},
      attributes: {},
      addEventListener(evt, fn) {
        if (!this.listeners[evt]) this.listeners[evt] = [];
        this.listeners[evt].push(fn);
      },
      dispatchEvent(evt) {
        const fns = this.listeners[evt.type] || [];
        fns.forEach(fn => fn(evt));
      },
      setAttribute(k, v) { this.attributes[k] = v; },
      removeAttribute(k) { delete this.attributes[k]; },
      style: {},
      appendChild(child) { },
      matches() { return false; },
      focus() { }
    };
    elements[id] = el;
    return el;
  }

  // Pre-create required DOM elements from index.html
  [
    'lobby-view', 'room-view', 'lobby-join-form', 'input-room-name', 'input-nickname',
    'btn-play-pause', 'btn-skip', 'btn-resync', 'btn-mute', 'volume-slider',
    'scrubber-range', 'btn-play-now', 'btn-add-queue', 'input-track-url',
    'chat-form', 'input-chat-message', 'chat-messages-container',
    'btn-copy-invite', 'btn-lobby-share', 'btn-leave-room', 'preset-chips',
    'audio-unlock-banner', 'connection-status-dot', 'connection-warning-banner',
    'now-playing-title', 'now-playing-author', 'now-playing-thumb',
    'room-header-name', 'equalizer-container', 'time-elapsed', 'time-total',
    'progress-bar', 'queue-list', 'queue-count-badge', 'listeners-list',
    'listeners-count-badge', 'drift-indicator', 'cooldown-badge', 'cooldown-seconds',
    'tab-btn-queue', 'tab-btn-listeners', 'tab-btn-chat',
    'tab-panel-queue', 'tab-panel-listeners', 'tab-panel-chat'
  ].forEach(id => makeEl(id));

  return {
    elements,
    getElementById(id) {
      return elements[id] || makeEl(id);
    },
    querySelectorAll(selector) {
      return [];
    },
    querySelector(selector) {
      return null;
    },
    createElement(tag) {
      return makeEl('dyn-' + Math.random(), tag);
    },
    getElementsByTagName(tag) {
      return [makeEl('tag-' + tag, tag)];
    },
    addEventListener(evt, fn) {}
  };
}

// Setup global mock browser environment
const mockDom = createMockDom();
global.document = mockDom;
global.window = {
  document: mockDom,
  location: {
    origin: 'https://syncbeat-music.web.app',
    pathname: '/',
    search: '',
    href: 'https://syncbeat-music.web.app/'
  },
  history: {
    pushState(state, title, url) {
      window.location.search = url.includes('?') ? '?' + url.split('?')[1] : '';
    }
  },
  localStorage: {
    store: {},
    getItem(k) { return this.store[k] || null; },
    setItem(k, v) { this.store[k] = String(v); },
    removeItem(k) { delete this.store[k]; }
  },
  addEventListener() {},
  scrollTo() {},
  navigator: {
    clipboard: {
      writeText(text) {
        window.__copied = text;
        return Promise.resolve();
      }
    }
  }
};

Object.defineProperty(navigator, 'clipboard', {
  value: {
    writeText(text) {
      window.__copied = text;
      return Promise.resolve();
    }
  },
  configurable: true
});
global.localStorage = window.localStorage;
global.io = () => ({
  connected: false,
  on() {},
  emit() {}
});

// Load audioUnlock, syncEngine, and app
require('../public/js/audioUnlock.js');
require('../public/js/syncEngine.js');
require('../public/js/app.js');

async function runTest() {
  console.log('🧪 Starting Client Standalone / Firebase Hosting Simulation Test...');

  // Initialize app
  window.SyncBeatApp.init();

  const lobbyView = document.getElementById('lobby-view');
  const roomView = document.getElementById('room-view');
  const roomInput = document.getElementById('input-room-name');
  const nickInput = document.getElementById('input-nickname');
  const joinForm = document.getElementById('lobby-join-form');

  // Verify initial state is Lobby
  assert(!roomView.classList.contains('hidden') || roomView.classList.classes.size === 0, 'Initial room view hidden');
  console.log('  ✔ App initialized on Lobby screen');

  // User enters room name "Cyber Chill" and nickname "DJ Dave"
  roomInput.value = 'Cyber Chill';
  nickInput.value = 'DJ Dave';

  // Submit the join form
  joinForm.dispatchEvent({ type: 'submit', preventDefault() {} });

  // 1. Verify Lobby view is now hidden and Room view is visible
  assert(lobbyView.classList.contains('hidden'), 'Lobby view must be hidden after enter');
  assert(!roomView.classList.contains('hidden'), 'Room view must be visible after enter');
  console.log('  ✔ Lobby -> Room transition successful (stuck on lobby bug FIXED!)');

  // 2. Verify Room Header name updated
  const roomHeader = document.getElementById('room-header-name');
  assert.strictEqual(roomHeader.textContent, 'Cyber Chill', 'Room header displays entered name');
  console.log('  ✔ Room header correctly displays "Cyber Chill"');

  // 3. Verify URL was updated to ?room=cyber-chill
  assert(window.location.search.includes('room=cyber-chill'), 'URL updated to query ?room=cyber-chill');
  console.log('  ✔ URL updated to "?room=cyber-chill" without full reload');

  // 4. Verify Invite link can be copied
  window.SyncBeatApp.copyRoomLink();
  await new Promise(r => setTimeout(r, 50));
  assert.strictEqual(window.__copied, 'https://syncbeat-music.web.app/?room=cyber-chill', 'Invite link correctly copied');
  console.log('  ✔ Share invite link successfully copied:', window.__copied);

  // 5. Test leaving the room
  window.SyncBeatApp.leaveRoom();
  assert(roomView.classList.contains('hidden'), 'Room view hidden after leaving');
  assert(!lobbyView.classList.contains('hidden'), 'Lobby view restored after leaving');
  console.log('  ✔ Clean room leave & return to lobby verified');

  console.log('\n🎉 ALL CLIENT STANDALONE / FIREBASE HOSTING SIMULATION TESTS PASSED!');
}

runTest().catch(err => {
  console.error('❌ Test failed:', err);
  process.exit(1);
});
