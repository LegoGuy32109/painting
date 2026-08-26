// @ts-check

/**
 * Fair carousel registry. Live work owns the carousel whenever any painter is
 * active. Each active id is offered once before a new round begins; completed
 * paintings use cursor-fed unseen ids before a shuffled repeat bag.
 */
export class ParadeState {
  constructor() {
    /** @type {Map<string, any>} */
    this.active = new Map();
    /** @type {Map<string, any>} */
    this.completed = new Map();
    /** @type {string[]} */
    this.activeRound = [];
    /** @type {string[]} */
    this.signedFirst = [];
    /** @type {string[]} */
    this.unseenCompleted = [];
    /** @type {string[]} */
    this.repeatBag = [];
    this.completedCursor = /** @type {string | null} */ (null);
    this.completedExhausted = false;
  }

  /** @param {any[]} items */
  syncActive(items) {
    const nextIds = new Set(items.map((item) => item.canvas.id));
    for (const id of this.active.keys()) {
      if (!nextIds.has(id)) this.removeActive(id);
    }
    for (const item of items) this.addActive(item.canvas);
  }

  /** @param {any} canvas @param {boolean} [priority] */
  addActive(canvas, priority = false) {
    const fresh = !this.active.has(canvas.id);
    this.active.set(canvas.id, canvas);
    if (!fresh || this.activeRound.includes(canvas.id)) return;
    if (priority) this.activeRound.unshift(canvas.id);
    else this.activeRound.push(canvas.id);
  }

  /** @param {string} id */
  removeActive(id) {
    this.active.delete(id);
    this.activeRound = this.activeRound.filter((candidate) => candidate !== id);
  }

  /** @param {any} canvas */
  complete(canvas) {
    this.removeActive(canvas.id);
    this.completed.set(canvas.id, canvas);
    this.signedFirst = [
      canvas.id,
      ...this.signedFirst.filter((id) => id !== canvas.id),
    ];
  }

  /** @param {any[]} paintings @param {string | null} nextCursor */
  addCompletedPage(paintings, nextCursor) {
    for (const canvas of paintings) {
      if (!this.completed.has(canvas.id)) {
        this.completed.set(canvas.id, canvas);
        this.unseenCompleted.push(canvas.id);
      } else {
        this.completed.set(canvas.id, canvas);
      }
    }
    this.completedCursor = nextCursor;
    this.completedExhausted = nextCursor === null;
  }

  /** @param {Set<string>} visibleIds */
  next(visibleIds) {
    if (this.active.size > 0) {
      let id = this.#takeAvailable(this.activeRound, visibleIds, this.active);
      if (!id && this.activeRound.length === 0) {
        this.activeRound = shuffle([...this.active.keys()]);
        id = this.#takeAvailable(this.activeRound, visibleIds, this.active);
      }
      return id ? { canvas: this.active.get(id), kind: "active" } : null;
    }

    let id = this.#takeAvailable(this.signedFirst, visibleIds, this.completed);
    if (!id) {
      id = this.#takeAvailable(
        this.unseenCompleted,
        visibleIds,
        this.completed,
      );
    }
    if (!id && this.completedExhausted) {
      if (this.repeatBag.length === 0) {
        this.repeatBag = shuffle([...this.completed.keys()]);
      }
      id = this.#takeAvailable(this.repeatBag, visibleIds, this.completed);
    }
    return id ? { canvas: this.completed.get(id), kind: "completed" } : null;
  }

  needsCompletedPage() {
    return this.active.size === 0 && !this.completedExhausted &&
      this.unseenCompleted.length < 6;
  }

  /** @param {string[]} queue @param {Set<string>} visible @param {Map<string, any>} catalog */
  #takeAvailable(queue, visible, catalog) {
    const attempts = queue.length;
    for (let index = 0; index < attempts; index++) {
      const id = queue.shift();
      if (!id || !catalog.has(id)) continue;
      if (visible.has(id)) {
        queue.push(id);
        continue;
      }
      return id;
    }
    return null;
  }
}

/** @template T @param {T[]} values @returns {T[]} */
function shuffle(values) {
  for (let index = values.length - 1; index > 0; index--) {
    const swap = Math.floor(Math.random() * (index + 1));
    [values[index], values[swap]] = [values[swap], values[index]];
  }
  return values;
}
