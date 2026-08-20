const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/**
 * Generates a ULID: a 48-bit millisecond timestamp (sortable) followed by 80
 * bits of randomness, encoded as 26-character Crockford Base32. Server-side
 * only — the client uses its own no-crypto equivalent (see app.js), since
 * browser `crypto` isn't reliably available outside a secure context.
 */
export function ulid(now: number = Date.now()): string {
  let timePart = "";
  let t = now;
  for (let i = 0; i < 10; i++) {
    timePart = CROCKFORD[t % 32] + timePart;
    t = Math.floor(t / 32);
  }

  const randomBytes = new Uint8Array(10);
  crypto.getRandomValues(randomBytes);
  let randomPart = "";
  for (const byte of randomBytes) {
    randomPart += CROCKFORD[byte % 32];
  }

  return timePart + randomPart;
}
