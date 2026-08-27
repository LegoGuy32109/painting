// Human-readable handles for upgraded profiles (accounts). There is no
// email in this product by explicit product decision, but WebAuthn still
// requires `user.name`/`user.displayName`, and password managers show them
// permanently — so accounts get a small generated name instead:
//
//     <Colour> <Mob> <4 hex chars>
//
// e.g. "Light Blue Axolotl 4F2A". The colour vocabulary is the app's own
// fixed 16-colour palette (docs/joy-of-painting-interface-spec.md); the
// mob list is Minecraft's own passive/friendly mobs. Everything here
// is a pure, synchronous function of (profileId, attempt) — no crypto, no
// db, no async — so mintHandle() is fully deterministic and testable in
// isolation, and mintUniqueHandle()'s collision-retry loop is testable
// against a fake "is this taken" predicate without touching a real
// database (see tests/handles_test.ts vs. the db-backed uniqueness check
// that actually lands in Phase 3's upgrade route).

// The app's fixed 16-colour palette names — see the "Base palette" table in
// docs/joy-of-painting-interface-spec.md. Kept as display names (some are
// two words), not the hex values.
const COLOURS = [
  "Black",
  "Red",
  "Green",
  "Brown",
  "Blue",
  "Purple",
  "Cyan",
  "Light Gray",
  "Gray",
  "Pink",
  "Lime",
  "Yellow",
  "Light Blue",
  "Magenta",
  "Orange",
  "White",
];

// Minecraft passive/friendly mobs — this app is a recreation of a
// Minecraft mod, and the colour half of the handle already comes from the
// mod's own palette, so the mob half matches that same register rather
// than being a generic animal list. A few of these (bee, goat, panda,
// dolphin, llama) are technically neutral rather than strictly passive;
// included anyway under a generous friendly-mob reading. No hostile mobs.
// Kept single-word deliberately: the colour list already has two-word
// entries ("Light gray", "Light blue"), and pairing one of those with a
// multi-word mob (e.g. "Wandering Trader") would produce a handle well
// over 30 characters for something a password manager displays
// permanently and the user can never rename.
const MOBS = [
  "Cow",
  "Chicken",
  "Rabbit",
  "Bee",
  "Pig",
  "Sheep",
  "Horse",
  "Donkey",
  "Mule",
  "Llama",
  "Cat",
  "Ocelot",
  "Parrot",
  "Fox",
  "Axolotl",
  "Turtle",
  "Frog",
  "Tadpole",
  "Allay",
  "Camel",
  "Sniffer",
  "Bat",
  "Squid",
  "Strider",
  "Goat",
  "Panda",
  "Dolphin",
  "Villager",
  "Mooshroom",
  "Armadillo",
  "Salmon",
  "Cod",
  "Pufferfish",
];

/**
 * A small, fast, non-cryptographic string hash (FNV-1a, 32-bit). Handles
 * are public display names, not secrets or access-control tokens, so a
 * non-cryptographic hash is the right tool: deterministic, synchronous,
 * and good enough distribution for picking words and hex digits.
 */
function fnv1a(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/**
 * Mints a candidate handle deterministically from `profileId` and
 * `attempt`. The whole string — colour, mob, AND the 4 hex characters —
 * comes from hashing `profileId` (plus `attempt`, so a collision on the
 * first attempt has a genuinely different second candidate to try, not a
 * repeat of the same string). Same inputs always produce the same output.
 */
export function mintHandle(profileId: string, attempt = 0): string {
  if (attempt < 0 || !Number.isInteger(attempt)) {
    throw new Error("attempt must be a non-negative integer");
  }
  const hash = fnv1a(`${profileId}#${attempt}`);
  const colour = COLOURS[hash % COLOURS.length];
  const mob = MOBS[Math.floor(hash / COLOURS.length) % MOBS.length];
  const hex = hash.toString(16).padStart(8, "0").toUpperCase().slice(0, 4);
  return `${colour} ${mob} ${hex}`;
}

/**
 * Finds a handle for `profileId` that `isTaken` reports as free, retrying
 * with successive attempts (see mintHandle) on a collision. `isTaken` is
 * injected rather than this module taking a db Client directly, so the
 * whole retry loop is testable against a plain in-memory predicate — the
 * real caller (Phase 3's upgrade route) passes one backed by a `profiles`
 * lookup.
 */
export async function mintUniqueHandle(
  profileId: string,
  isTaken: (candidate: string) => boolean | Promise<boolean>,
  maxAttempts = 8,
): Promise<string> {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const candidate = mintHandle(profileId, attempt);
    if (!(await isTaken(candidate))) return candidate;
  }
  throw new Error(
    `could not find an available handle for this profile after ${maxAttempts} attempts`,
  );
}
