# Transfer codes

This product has **no email, no password, and no account-recovery flow**,
by explicit and repeated product decision. The account IS the passkey set
(see `RELATED-ORIGIN-REQUESTS.md` at the repo root and the Phase 3/4 notes in
`src/server/main.ts`). Transfer codes are the one primitive that makes that
survivable. One mechanism, three problems:

- **Bootstrapping a second device** that has no passkey on it yet.
- **Recovery when platform passkey sync isn't available** — a
  `backed_up = 0` (device-bound) credential has no other way off its
  device.
- **The iOS install-jar trap**: a home-screen web app on iOS gets its own
  cookie/storage jar, entirely separate from Safari's, with no API that
  bridges the two. A guest who paints in Safari and then installs the app
  lands in a brand-new, empty profile — from their point of view, their
  paintings vanished. A code generated in the Safari tab and entered in the
  installed app is the only way to carry that profile across. This does
  NOT happen on Android/Chrome, where the installed PWA shares storage with
  the browser — which is exactly why it's easy to miss in testing (see
  `src/client/pwa.js`'s `maybeShowIosTransferHint()`).

## Why a database lookup, not a signed token

`src/server/merge-token.ts`'s merge token is signed and self-contained —
appropriate there because it's never retyped by a human, only round-tripped
by the browser. A transfer code is the opposite: it exists specifically to
be read off one screen and typed into another, so it has to be short. Eight
characters is nowhere near enough room for a signature plus a payload, so a
transfer code carries no information at all beyond itself — it's a bare
lookup key into the `transfer_codes` table (`code`, `profile_id`,
`expires_at`, `consumed_at`, `failed_attempts`; the last added in
`migrations/002_transfer_code_attempts.sql`, Phase 2's `001_initial.sql`
being immutable once applied). This is *why* the security properties below
matter more here than for the merge token: there's no cryptography doing
any of the work, only the database state.

## Format

Eight characters, Crockford base32 (`0123456789ABCDEFGHJKMNPQRSTVWXYZ`) —
32 symbols, deliberately excluding `I`, `L`, `O`, `U`: no ambiguity against
`1`/`I`, `l`/`1`, `0`/`O`, and no accidental profanity from a
vowel-complete alphabet. Generated via `crypto.getRandomValues()`, never
`Math.random()` — see `src/shared/transfer-code.js`. ~40 bits of entropy,
1 in ~1.1×10¹² per blind guess.

Displayed grouped for readability (`AB12-CD34`); accepted back
case-insensitively, with or without the hyphen, and with surrounding
whitespace stripped (`normalizeTransferCode()`) — a user typing exactly
what they see on the other screen should always work.

## Who can generate one

**Both guests and accounts.** The iOS install-jar case above is precisely a
guest with zero credentials who needs to move a profile — gating
generation behind having an account would make the mechanism useless for
the case that needs it most. `POST /api/auth/transfer` only requires *a*
session (guest or account), the same bar every other mutating route in
this app clears.

## Consumption reuses Phase 4's merge machinery — on purpose

Consuming a code proves "I am this profile" exactly as much as a verified
passkey assertion does; from that point on, the situation is identical to
signing in with a passkey: the device might already have its own
in-progress draft, in which case that's the same four-case merge table
Phase 4 built (`src/server/main.ts`'s `resolveSignInMerge()`), including the
deferred-cookie-rotation property (nothing changes until a decision is
reached; backing out of the merge dialog costs nothing) and the two-thumbnail
dialog in `/collection`. `POST /api/auth/transfer/consume` and
`POST /api/auth/login/verify` both end by calling `resolveSignInMerge()` —
there is exactly one implementation of that decision, not two kept in sync
by hand.

## Security properties

**Single-use.** Consuming is one conditional `UPDATE ... WHERE code = ? AND
consumed_at IS NULL AND expires_at >= ? AND failed_attempts < 3`, checked
via `rowsAffected === 1` — the same read-free, race-proof pattern
`consumeChallenge()` already uses for WebAuthn challenges. Two simultaneous
requests for the same code cannot both "win."

**10-minute expiry.** Long enough to read a code off one screen and type it
into another; short enough that a code left in a screenshot or a
shoulder-surfed glance is only dangerous briefly.

**Per-code attempt exhaustion (3).** Every submission — right or wrong,
existing or not — that fails to consume a code that DOES exist in the
table increments that row's `failed_attempts`; once it reaches 3, the code
is dead regardless of how much of its TTL remains. This is a second,
independent layer under the IP-based rate limiter below: it bounds how many
times any ONE already-observed candidate string can be retried at all,
regardless of how many different IP addresses it's tried from — closing the
gap an attacker distributing the same guess across many IPs would otherwise
have against a purely IP-keyed limiter.

**IP-keyed rate limiting** (`src/server/rate-limit.ts`'s
`consumeIpMutation()`), because minting a fresh guest profile is free and
unlimited, which makes anything keyed only by guest id (`consumeGuestMutation`)
trivially bypassable by an attacker who just gets a new cookie per request.
Bucket: capacity 20, refilling 1 token every 15 seconds (4/minute
sustained).
- **Consume** costs 1 token per attempt: a burst of 20 guesses, then
  throttled to 4/minute — at most ~60 attempts from one IP address across
  one code's entire 10-minute life.
- **Generate** costs 5 tokens per call: a burst of 4 generations, then
  throttled to roughly one every 75 seconds — enough for a real person
  occasionally moving a profile, expensive for a flood. This exists so an
  attacker can't cheaply widen the "outstanding codes" population (more
  live codes at once raises the base rate at which a blind guess lands on
  *some* profile's code, even though it still doesn't help them target a
  *specific* one).

Both routes return `429` with `retry-after` once their bucket empties.

**How the client IP is obtained, and how much it's trusted:** `x-forwarded-for`'s
LAST comma-separated entry (`clientIp()` in `src/server/main.ts`) — the
entry the closest, most-trusted proxy hop appended, as opposed to the
FIRST entry, which is whatever the original client sent and is entirely
attacker-controlled. On this app's single-hop Deno Deploy topology, that
last entry is the address Deno Deploy's own edge recorded. `remoteAddr`
from `Deno.serve`'s handler info is used only as a local-dev fallback (no
proxy in front there, so it genuinely is the caller); a request with
neither collapses to the literal string `"unknown"`, so every such caller
shares one bucket — this fails SAFE (over-throttling a shared bucket, not
skipping the limiter). None of this is cryptographically trustworthy —
it's exactly the same "slow down a flood, not a guarantee" posture
`consumeGuestMutation`'s own doc comment already states for its guest-id
keying.

**The consume error is deliberately uninformative.** "That code is
invalid, expired, or already used" is the ONE message for every failure
case — unknown code, wrong code, expired, already consumed, or exhausted —
so a guessing attacker never learns "that candidate exists but is dead"
versus "that candidate never existed at all."

**Opportunistic sweeping.** `createTransferCode()` deletes expired-or-consumed
rows before inserting a new one, the same pattern `createChallenge()`
already uses for WebAuthn challenges — no cron needed to keep the table
from growing unbounded.

## What this does NOT do

Nothing here defends a code once it's been read by the wrong person before
the intended recipient uses it (a passkey doesn't have this problem — it
never leaves the authenticator). That's an inherent property of "a short
string meant to be read off a screen," not a gap in this implementation;
the 10-minute TTL and single-use consumption are the mitigation, not a fix.
