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
  // A denied request must not spend anything. Clamping a shortfall to zero
  // instead charged the caller everything it had left, so one rejected
  // multi-token request (an events push costs 1 + events/8) reset a bucket
  // that was merely short of THAT request back to empty — and the delete +
  // re-set below is what keeps this Map in LRU order for the eviction above.
  const allowed = tokens >= cost;
  buckets.delete(guestId);
  buckets.set(guestId, {
    tokens: allowed ? tokens - cost : tokens,
    updatedAt: now,
  });
  return allowed;
}

// --- IP-keyed limiter (Phase 5: transfer codes) ---------------------------
//
// Minting a fresh guest profile is free and unlimited, so anything keyed
// only by guestId (consumeGuestMutation above) is trivially bypassed by an
// attacker who just gets a new cookie per request. Transfer-code
// generation and consumption are the one place in this app where that
// matters enough to add a second bucket keyed by the caller's IP address
// instead — see clientIp() in main.ts for how that address is obtained
// (best-effort; not cryptographically trustworthy, see its own doc
// comment) and docs/transfer-codes.md for the full reasoning behind the
// specific numbers below.
//
// Capacity 20, refilling 1 token every 15 seconds (4/minute sustained):
// generation costs 5 tokens per call (a burst of 4 immediate generations,
// then throttled to roughly one every 75 seconds — plenty for a real user
// occasionally moving a profile, expensive for a flood); consumption costs
// 1 token per call (a burst of 20 guesses, then throttled to 4/minute — at
// most ~60 guesses from one IP address across one code's entire 10-minute
// life). Deliberately a SEPARATE Map from the guest-keyed bucket above:
// different keyspace, different tuning, no reason to couple them.
const IP_CAPACITY = 20;
const IP_REFILL_PER_MS = 1 / 15_000;
const MAX_IP_BUCKETS = 10_000;

const ipBuckets = new Map<string, Bucket>();

export function consumeIpMutation(
  ip: string,
  cost = 1,
  now = Date.now(),
): boolean {
  const previous = ipBuckets.get(ip);
  const elapsed = previous ? Math.max(0, now - previous.updatedAt) : 0;
  const tokens = previous
    ? Math.min(IP_CAPACITY, previous.tokens + elapsed * IP_REFILL_PER_MS)
    : IP_CAPACITY;

  if (!previous && ipBuckets.size >= MAX_IP_BUCKETS) {
    const oldest = ipBuckets.keys().next().value;
    if (oldest !== undefined) ipBuckets.delete(oldest);
  }
  // Denied requests spend nothing here either — see consumeGuestMutation.
  // It matters more on this bucket: generation costs 5, so a single
  // rejected generate used to wipe out the 4 tokens a legitimate consume
  // (cost 1) would otherwise still have had.
  const allowed = tokens >= cost;
  ipBuckets.delete(ip);
  ipBuckets.set(ip, {
    tokens: allowed ? tokens - cost : tokens,
    updatedAt: now,
  });
  return allowed;
}
