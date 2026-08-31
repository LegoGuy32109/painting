# Rotating the signing keyset

`PAINTING_KEYS` (see `src/server/signing-keys.ts` and `.env.example`) is the
ordered, comma-separated keyset every HMAC-authenticated artifact this server
issues is signed and verified against: guest session cookies today
(`src/server/guest-session.ts`), WebAuthn challenges / merge tokens /
transfer codes once Phases 3-5 land. This doc is the procedure for adding a
new key and retiring an old one. Written the day the code shipped, because a
rotation procedure that only lives in someone's head never gets executed.

## Why rotate at all

A key that's never rotated is a key an old leak (a logged env var, a
compromised deploy credential, a careless copy into a chat) stays valid for
forever. Rotation bounds that exposure. It's also just good practice to be
*able* to rotate under pressure without an outage — that's the whole point of
`PAINTING_KEYS` supporting more than one entry instead of Phase 0's
single-secret-plus-one-previous stopgap.

## The procedure

### 1. Generate a new key

```bash
openssl rand -base64 32 | tr '+/' '-_' | tr -d '='
```

Pick a kid that hasn't been used before (short, opaque, matches
`/^[a-z0-9]{1,16}$/` — `k1`, `k2`, `k3`, ... is fine, there's no meaning
beyond "which key").

### 2. Prepend it as the new primary

`PAINTING_KEYS` is order-sensitive: the **first** entry is the one new
tokens are signed under; every entry is tried when verifying. To rotate,
prepend the new key and keep the old one(s):

```
PAINTING_KEYS=k4:<new-key>,k3:<old-key>,k2:<older-key>
```

Set this per context with `scripts/set-deploy-env.ts` — **not**
`deno deploy env add`, which forces one value across every context and is
exactly wrong here (see `docs/deno-deploy-env-vars.md`). Production, Preview,
and Local each carry their own independent keyset; rotate them independently,
on whatever schedule each context needs.

```bash
deno run -A scripts/set-deploy-env.ts Production PAINTING_KEYS "k4:<new-key>,k3:<old-key>"
```

### 3. Deploy

Once the new `PAINTING_KEYS` is live, every fresh guest session and every
existing session re-issued during its normal traffic gets signed under the
new primary (`k4`). Sessions still carrying an old kid (`k3`, `k2`, ...)
keep verifying — see `guest-session.ts`'s `isPrimaryKid` check — and get
transparently re-signed under `k4` the next time their guest visits.

### 4. The waiting period — and why a full drain is impractical

The guest cookie's `Max-Age` is 400 days. A guest who set their cookie the
day before a rotation and doesn't visit again for over a year is still
carrying the old kid right up until they do. Waiting for every single guest
to naturally revisit before dropping an old key is not a realistic bar — most
rotations should instead pick a deliberately shorter waiting window (weeks to
a few months, driven by how urgent the rotation is) and accept that dropping
the old key early has a real, specific cost:

**Dropping a key while guests still carry tokens signed under it forces a
fresh guest identity for exactly those guests** — this is precisely
Defect 1's failure mode (see the Phase 0 notes), except deliberate rather
than accidental. Their signed paintings become orphaned server-side and
their collection reads empty. That tradeoff is sometimes the right call (a
suspected leak trumps a slow drain) and sometimes not (routine hygiene
rotation can afford to wait longer) — but it must be a decision someone
makes on purpose, not something that happens because nobody thought about
who was still holding the old key.

Once passkey accounts exist (Phase 3+), this cost drops sharply: an account
holder just re-authenticates with their passkey and their profile survives
regardless of which key their session cookie happened to carry. Only guests
who never upgraded to an account are exposed to this tradeoff at all — one
more reason the passkey work matters beyond the feature itself.

### 5. Remove the retired key

After the waiting period, drop the oldest entry from `PAINTING_KEYS` in each
context:

```bash
deno run -A scripts/set-deploy-env.ts Production PAINTING_KEYS "k4:<new-key>,k3:<old-key>"
```

Verify the deploy picked it up (`assertSigningKeysConfigured()` hard-fails
at boot if the new value is somehow malformed — a bad edit here fails loud,
not silent), then the retired key is gone. There is no way to see who's still
holding a cookie signed under it before you drop it; the waiting period in
step 4 is the only lever.

## Legacy `GUEST_SESSION_SECRET` / `GUEST_SESSION_SECRET_PREVIOUS`

These predate `PAINTING_KEYS` (Phase 0) and are kept only as legacy
*verification* inputs so guests still carrying a v1/v2 cookie migrate
forward to v3 — nothing signs with them anymore. They are not part of the
keyset and don't get a kid; they don't need rotating, only eventual removal
once enough time has passed that no v1/v2 cookie could plausibly still be in
the wild (see the comment above them in `.env.example`).
