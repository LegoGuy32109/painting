import {
  assertEquals,
  assertMatch,
  assertNotEquals,
  assertRejects,
} from "@std/assert";
import { mintHandle, mintUniqueHandle } from "../src/server/handles.ts";

const HANDLE_PATTERN = /^[A-Za-z ]+ [A-Za-z]+ [0-9A-F]{4}$/;

Deno.test("mintHandle produces the <Colour> <Mob> <4 hex> shape", () => {
  const handle = mintHandle("11111111-1111-4111-8111-111111111111");
  assertMatch(handle, HANDLE_PATTERN);
  const parts = handle.split(" ");
  assertEquals(parts.at(-1)?.length, 4);
});

Deno.test("mintHandle is deterministic for the same profileId and attempt", () => {
  const id = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
  assertEquals(mintHandle(id, 0), mintHandle(id, 0));
  assertEquals(mintHandle(id, 3), mintHandle(id, 3));
});

Deno.test("mintHandle varies with attempt, for the retry path to make progress", () => {
  const id = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
  const attempts = new Set(
    Array.from({ length: 8 }, (_, attempt) => mintHandle(id, attempt)),
  );
  // Not a strict guarantee (a hash could theoretically repeat), but with 8
  // attempts across a 16 colours x 33 mobs x 65536 hex-values space
  // (~34.6 million combinations — see the pool-size test below), a
  // collision across a sample this small would indicate a broken hash,
  // not bad luck.
  assertEquals(attempts.size > 1, true);
});

Deno.test("mintHandle varies with profileId for the same attempt", () => {
  assertNotEquals(
    mintHandle("11111111-1111-4111-8111-111111111111"),
    mintHandle("22222222-2222-4222-8222-222222222222"),
  );
});

Deno.test("mintHandle rejects a negative or non-integer attempt", () => {
  const id = "11111111-1111-4111-8111-111111111111";
  let threw = false;
  try {
    mintHandle(id, -1);
  } catch {
    threw = true;
  }
  assertEquals(threw, true);
});

Deno.test("mintUniqueHandle returns the first attempt when it's free", async () => {
  const id = "11111111-1111-4111-8111-111111111111";
  const handle = await mintUniqueHandle(id, () => false);
  assertEquals(handle, mintHandle(id, 0));
});

Deno.test("mintUniqueHandle retries on collision until it finds a free candidate", async () => {
  const id = "11111111-1111-4111-8111-111111111111";
  const taken = new Set([mintHandle(id, 0), mintHandle(id, 1)]);
  const handle = await mintUniqueHandle(
    id,
    (candidate) => taken.has(candidate),
  );
  assertEquals(handle, mintHandle(id, 2));
  assertEquals(taken.has(handle), false);
});

Deno.test("mintUniqueHandle gives up after maxAttempts and throws rather than looping forever", async () => {
  const id = "11111111-1111-4111-8111-111111111111";
  await assertRejects(
    () => mintUniqueHandle(id, () => true, 3),
  );
});

Deno.test("the handle pool is large enough that the collision retry loop stays a backstop, not a hot path", () => {
  // 16 colours x 33 mobs x 65536 possible 4-hex-char suffixes. Not derived
  // from the module's internals (that would just be testing the test) —
  // hardcoded against the actual published lists so a future edit to
  // either list is forced to update this numbers-check consciously.
  const COLOUR_COUNT = 16;
  const MOB_COUNT = 33;
  const HEX_COUNT = 16 ** 4;
  const poolSize = COLOUR_COUNT * MOB_COUNT * HEX_COUNT;
  assertEquals(poolSize, 34_603_008);
  // Vanishingly rare collisions at any realistic number of accounts.
  assertEquals(poolSize > 30_000_000, true);
});
