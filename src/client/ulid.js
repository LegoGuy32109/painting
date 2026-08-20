// @ts-check

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/**
 * Same 26-char Crockford Base32 shape as src/server/ulid.ts, but Math.random()
 * instead of crypto.getRandomValues() — browser `crypto` isn't reliably
 * available outside a secure context, which is what broke touch drawing over
 * a plain-HTTP Tailscale connection originally.
 * @param {number} [now]
 * @returns {string}
 */
export function localUlid(now = Date.now()) {
  let timePart = "";
  let t = now;
  for (let i = 0; i < 10; i++) {
    timePart = CROCKFORD[t % 32] + timePart;
    t = Math.floor(t / 32);
  }
  let randomPart = "";
  for (let i = 0; i < 10; i++) {
    randomPart += CROCKFORD[Math.floor(Math.random() * 32)];
  }
  return timePart + randomPart;
}
