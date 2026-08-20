// @ts-check

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/**
 * A 26-character Crockford Base32 ULID shared by browser and server code.
 * crypto.getRandomValues() is available outside secure contexts too.
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
  const randomBytes = new Uint8Array(16);
  crypto.getRandomValues(randomBytes);
  let randomPart = "";
  for (const byte of randomBytes) randomPart += CROCKFORD[byte % 32];
  return timePart + randomPart;
}

export const ulid = localUlid;
