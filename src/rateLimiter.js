/**
 * In-Memory Sliding Window Rate Limiter
 * Limits sensitive actions (track changes, play/pause toggles, skips)
 * to 2 actions per 15-second sliding window per socket/IP.
 */

class SlidingWindowRateLimiter {
  constructor(limit = 2, windowMs = 15000) {
    this.limit = limit;
    this.windowMs = windowMs;
    this.records = new Map(); // key -> [timestamp, timestamp, ...]

    // Clean up idle records every 60 seconds
    setInterval(() => this.cleanup(), 60000).unref();
  }

  /**
   * Checks if an action is allowed for the given key.
   * If allowed, records the action timestamp and returns { allowed: true }.
   * If blocked, returns { allowed: false, cooldownRemainingSec, remainingMs }.
   * 
   * @param {string} key 
   * @returns {{ allowed: boolean, cooldownRemainingSec?: number, remainingMs?: number }}
   */
  consume(key) {
    const now = Date.now();
    let timestamps = this.records.get(key) || [];

    // Filter timestamps within the current sliding window
    timestamps = timestamps.filter(t => (now - t) < this.windowMs);

    if (timestamps.length >= this.limit) {
      // Find when the oldest action in window expires
      const oldest = timestamps[0];
      const remainingMs = Math.max(0, (oldest + this.windowMs) - now);
      const cooldownRemainingSec = Math.ceil(remainingMs / 1000);

      this.records.set(key, timestamps);
      return {
        allowed: false,
        cooldownRemainingSec,
        remainingMs
      };
    }

    // Allow and record
    timestamps.push(now);
    this.records.set(key, timestamps);

    return { allowed: true };
  }

  /**
   * Peek remaining cooldown for a key without consuming
   * @param {string} key 
   * @returns {number} Cooldown seconds remaining (0 if no cooldown)
   */
  getCooldown(key) {
    const now = Date.now();
    let timestamps = this.records.get(key) || [];
    timestamps = timestamps.filter(t => (now - t) < this.windowMs);
    if (timestamps.length >= this.limit) {
      const oldest = timestamps[0];
      return Math.ceil(Math.max(0, (oldest + this.windowMs) - now) / 1000);
    }
    return 0;
  }

  /**
   * Housekeeping: removes expired keys from memory
   */
  cleanup() {
    const now = Date.now();
    for (const [key, timestamps] of this.records.entries()) {
      const valid = timestamps.filter(t => (now - t) < this.windowMs);
      if (valid.length === 0) {
        this.records.delete(key);
      } else {
        this.records.set(key, valid);
      }
    }
  }
}

module.exports = SlidingWindowRateLimiter;
