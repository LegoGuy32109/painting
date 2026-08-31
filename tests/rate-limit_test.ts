import { assertEquals } from "@std/assert";
import { consumeGuestMutation } from "../src/server/rate-limit.ts";

Deno.test("guest mutation limiter permits bursts then refills", () => {
  const guest = crypto.randomUUID();
  for (let i = 0; i < 120; i++) {
    assertEquals(consumeGuestMutation(guest, 1, 1_000), true);
  }
  assertEquals(consumeGuestMutation(guest, 1, 1_000), false);
  assertEquals(consumeGuestMutation(guest, 1, 1_100), true);
});

Deno.test("a denied request spends nothing, so a cheaper one can still pass", () => {
  const guest = `denied-costs-nothing-${crypto.randomUUID()}`;
  // Spend down to 3 tokens.
  for (let i = 0; i < 117; i++) {
    assertEquals(consumeGuestMutation(guest, 1, 1_000), true);
  }
  // A 5-token request cannot be served...
  assertEquals(consumeGuestMutation(guest, 5, 1_000), false);
  // ...and must not have consumed the 3 that were there. Clamping the
  // shortfall to zero used to charge the caller everything it had left.
  assertEquals(consumeGuestMutation(guest, 3, 1_000), true);
  assertEquals(consumeGuestMutation(guest, 1, 1_000), false);
});
