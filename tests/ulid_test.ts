import { assertEquals, assertMatch, assertNotEquals } from "@std/assert";
import { localUlid, ulid } from "../src/shared/ulid.js";

const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/;

Deno.test("client and server generate standard 26-character ULIDs", () => {
  const clientId = localUlid(1_700_000_000_000);
  const serverId = ulid(1_700_000_000_000);
  assertMatch(clientId, ULID);
  assertMatch(serverId, ULID);
  assertEquals(clientId.slice(0, 10), serverId.slice(0, 10));
  assertNotEquals(localUlid(1_700_000_000_000), clientId);
});
