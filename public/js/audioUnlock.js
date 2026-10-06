/**
 * Audio Unlock & Autoplay Resilience Handler
 * Primes the Web Audio AudioContext and un-mutes the YouTube IFrame player
 * upon first user touch/click to comply with mobile iOS/Android & browser autoplay policies.
 */

window.SyncBeatAudioUnlock = (function () {
  let audioContext = null;
  let isUnlocked = false;
  let bannerEl = null;
  let unlockCallbacks = [];

  function getAudioContext() {
    if (!audioContext) {
      const AudioContextClass = window.AudioContext || window.webkitAudioContext;
      if (AudioContextClass) {
        audioContext = new AudioContextClass();
      }
    }
    return audioContext;
  }

  function init(bannerElementId, onUnlocked) {
    bannerEl = document.getElementById(bannerElementId);
    if (onUnlocked) {
      unlockCallbacks.push(onUnlocked);
    }

    // Attach unlock trigger to the banner if it exists
    if (bannerEl) {
      bannerEl.addEventListener('click', triggerUnlock);
      bannerEl.addEventListener('touchend', triggerUnlock);
    }

    // Non-intrusive global gesture listener for first user touch or click
    const globalUnlockListener = () => {
      triggerUnlock();
      document.removeEventListener('click', globalUnlockListener);
      document.removeEventListener('keydown', globalUnlockListener);
      document.removeEventListener('touchstart', globalUnlockListener);
    };

    document.addEventListener('click', globalUnlockListener, { passive: true });
    document.addEventListener('keydown', globalUnlockListener, { passive: true });
    document.addEventListener('touchstart', globalUnlockListener, { passive: true });
  }

  function triggerUnlock() {
    if (isUnlocked) return;

    try {
      const ctx = getAudioContext();
      if (ctx) {
        if (ctx.state === 'suspended') {
          ctx.resume();
        }
        // Play a momentary silent buffer to prime audio hardware
        const buffer = ctx.createBuffer(1, 1, 22050);
        const source = ctx.createBufferSource();
        source.buffer = buffer;
        source.connect(ctx.destination);
        source.start(0);
      }
    } catch (e) {
      console.warn('[AudioUnlock] Web Audio prime warning:', e);
    }

    isUnlocked = true;

    if (bannerEl) {
      bannerEl.classList.add('hidden');
    }

    // Execute callbacks (such as un-muting YouTube player)
    unlockCallbacks.forEach(cb => {
      try { cb(); } catch (err) { console.error(err); }
    });
  }

  function showBanner() {
    if (!isUnlocked && bannerEl) {
      bannerEl.classList.remove('hidden');
    }
  }

  function hideBanner() {
    if (bannerEl) {
      bannerEl.classList.add('hidden');
    }
  }

  function registerCallback(cb) {
    if (typeof cb === 'function') {
      unlockCallbacks.push(cb);
      if (isUnlocked) {
        cb();
      }
    }
  }

  return {
    init,
    triggerUnlock,
    showBanner,
    hideBanner,
    registerCallback,
    isUnlocked: () => isUnlocked
  };
})();
