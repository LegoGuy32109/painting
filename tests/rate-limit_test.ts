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
