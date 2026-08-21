// @ts-check

/** @typedef {{ ts: number, cells: Array<[number, number]> }} ReplayBatch */

/**
 * Timing-only state behind /dev/active's live playback. It has no DOM or
 * EventSource dependency, so real painting recordings can test it directly.
 */
export class LiveReplay {
  /** @param {{ lagMs?: number, catchUpThresholdMs?: number }} [options] */
  constructor(options = {}) {
    this.lagMs = options.lagMs ?? 500;
    this.catchUpThresholdMs = options.catchUpThresholdMs ?? 2_000;
    /** @type {ReplayBatch[]} */
    this.queue = [];
    this.baseServerTs = null;
    this.baseLocalTime = null;
  }

  /** @returns {number} */
  get queuedBatches() {
    return this.queue.length;
  }

  reset() {
    this.queue = [];
    this.baseServerTs = null;
    this.baseLocalTime = null;
  }

  /** @param {ReplayBatch[]} batches @param {number} now */
  receive(batches, now) {
    for (const batch of batches) {
      if (this.baseServerTs === null || this.baseLocalTime === null) {
        this.baseServerTs = batch.ts;
        this.baseLocalTime = now + this.lagMs;
      } else if (now - this.targetTime(batch.ts) > this.catchUpThresholdMs) {
        // A throttled tab restarts near live instead of growing a backlog.
        this.baseServerTs = batch.ts;
        this.baseLocalTime = now + this.lagMs;
      }
      this.queue.push(batch);
    }
  }

  /** @param {number} ts */
  targetTime(ts) {
    return /** @type {number} */ (this.baseLocalTime) +
      (ts - /** @type {number} */ (this.baseServerTs));
  }

  /** @param {number} now @returns {ReplayBatch[]} */
  drain(now) {
    /** @type {ReplayBatch[]} */
    const due = [];
    while (this.queue.length > 0 && this.targetTime(this.queue[0].ts) <= now) {
      const batch = this.queue.shift();
      if (batch) due.push(batch);
    }
    return due;
  }
}
