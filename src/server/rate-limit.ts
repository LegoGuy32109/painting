const CAPACITY = 120;
const REFILL_PER_MS = 10 / 1_000;
const MAX_BUCKETS = 10_000;

interface Bucket {
  tokens: number;
  updatedAt: number;
}

const buckets = new Map<string, Bucket>();

/**
 * A small per-instance guard against runaway clients. It is not a replacement
 * for edge-level abuse controls because a caller can mint a new guest profile,
 * but it prevents a broken or replaying browser from hammering Turso.
 */
export function consumeGuestMutation(
  guestId: string,
  cost = 1,
  now = Date.now(),
): boolean {
  const previous = buckets.get(guestId);
  const elapsed = previous ? Math.max(0, now - previous.updatedAt) : 0;
  const tokens = previous
    ? Math.min(CAPACITY, previous.tokens + elapsed * REFILL_PER_MS)
    : CAPACITY;

  if (!previous && buckets.size >= MAX_BUCKETS) {
    const oldest = buckets.keys().next().value;
    if (oldest !== undefined) buckets.delete(oldest);
  }
  buckets.delete(guestId);
  buckets.set(guestId, {
    tokens: Math.max(0, tokens - cost),
    updatedAt: now,
  });
  return tokens >= cost;
}
