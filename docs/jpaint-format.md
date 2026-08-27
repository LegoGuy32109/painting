# The `.jpaint` export format

`GET /canvases/:id/jpaint` returns the full, self-contained export document for
one signed painting — the app-native archival/interop format. It is **not** an
attempt to reproduce the source Minecraft mod's `.paint` NBT structure; see
"Mapping to the mod's `.paint` format" below for exactly where the two do and
don't line up.

The encoder and decoder both live in `src/shared/jpaint.js` — plain, DOM-free JS
with `// @ts-check`/JSDoc, not TypeScript in `src/server/` — because a
browser-side `.jpaint` reader is a real feature (letting a user inspect or
re-import an exported file client-side) and `src/server/` code is never
importable from the browser. See `buildJpaintDocument()` (encoder) and
`decodeJpaintDocument()` (decoder) there.

## Why our own field names

An earlier draft of this format used the mod's own field names (`ct`, `v`,
`name`, `generation`) so a hypothetical converter would be a closer
byte-for-byte match. That was the wrong goal: this app has its own data model
(profiles, handles, a durable event log, content-hashed assets — see the earlier
phase notes throughout this repo) and forcing our export format to pre-conform
to a different system's field names buys nothing today and constrains us for no
reason. `.jpaint` uses this app's own vocabulary throughout. A converter, if one
is ever built, translates at its own boundary — that's its job, not this
format's.

## Losslessness guarantee

**Losslessness is defined with respect to our own data model, not the mod's.** A
`.jpaint` document round-trips everything this app itself persists for a signed
painting: the final pixel state, its metadata, and the complete edit history. It
does not — and cannot — guarantee anything about a concept our model doesn't
have (see `generation` and `v` below).

Concretely, that means `events` is the canvas's **full, unbounded event log**,
not a bounded or clamped one. This is a deliberate, explicit choice between two
options:

1. **Full log** (chosen): every `canvas_events` row for the canvas, in
   `sequence` order, no truncation.
2. **Bounded log + authoritative final pixels**: the same
   bounded/clamped-timeline approach `buildCanvasReplay()` already uses for
   `GET /canvases/:id/replay` — which caps at `REPLAY_EVENT_LIMIT` (4,000)
   events and clamps inter-event gaps to `MAX_REPLAY_GAP_MS` (500ms) so a long
   pause between strokes doesn't stall the live ambient display's animation.

Option 2 is the right call for `/replay` — it exists to drive a bounded-time UI
animation, not to preserve history, and bounding it is a feature, not a
compromise. It is the wrong call for `.jpaint`: an archival export's entire
purpose is fidelity, and silently dropping the early history of a painting with
a long edit session would break the one guarantee this format makes, for exactly
the paintings a user is most likely to want a lossless copy of.
**`/canvases/:id/jpaint` therefore never calls `buildCanvasReplay()` — it reads
the canvas's event log directly** (see `buildJpaintDocument()` in
`src/server/jpaint.ts`), and includes every row.

`pixels` is included too, separately from `events`, as the authoritative final
render (the same composed snapshot stored in `canvases.pixels` at signing time —
see `storeCanvasPixels()` in `db.ts`). A consumer that only wants the finished
image needs just `pixels`; one that wants to replay the painting
stroke-by-stroke needs `events` (plus `width`/`height`, to reconstruct via
`composeCanvas()`).

## Format

```jsonc
{
  "jpaint": 1,                 // format version — always the first key
  "id": "01ABC...",            // this canvas's id
  "title": "Clouds" | null,
  "author": "Cerulean Otter 4F2A" | null,
  "width": 16,
  "height": 16,                // NEVER inferred from pixel count — see below
  "createdAt": 1700000000000,  // epoch ms
  "completedAt": 1700000005000,
  "pixels": "<base64 of the Int32Array pixel buffer>",
  "events": [
    {
      "sequence": 1,
      "id": "01DEF...",
      "kind": "stroke" | "undo",
      "strokeId": "01GHI..." | null,
      "cells": "<base64-encoded cell diff>" | null,
      "revertsId": "01GHI..." | null,
      "clientTs": 1700000001000
    }
    // ... every event for this canvas, in sequence order
  ]
}
```

`width`/`height` are recorded explicitly and never inferred from
`pixels.length`: a 32×16 ("Long") canvas and a 16×32 ("Tall") canvas hold the
same pixel COUNT but are different shapes, so buffer length alone is ambiguous.
This app is fixed at `CANVAS_WIDTH`/`CANVAS_HEIGHT` = 16×16 today (see
`src/shared/paint-engine.js`) — the four canvas types in
`docs/joy-of-painting-interface-spec.md` are not yet implemented — but the
format doesn't bake today's fixed size in as an assumption.

`pixels` and each event's `cells` use the same base64-of-`Int32Array`/
base64-of-cell-diff encoding already used elsewhere in this app
(`PublicCanvas.pixels`, `PushEventPayload.cells`) — nothing new to decode. The
signed-high-bit trap that motivates `docs/joy-of-painting-interface-spec.md`'s
warning against encoding pixels as hex strings doesn't apply here at all: we
already preserve pixels as signed 32-bit integers end to end, and base64 of the
raw buffer carries that through byte-for-byte.

## Decoding: `decodeJpaintDocument()`

`decodeJpaintDocument()` (`src/shared/jpaint.js`) is the format's other half —
it accepts either raw file text or an already-`JSON.parse()`d value and returns
a fully-populated `JpaintDocument`, or throws `JpaintFormatError`. There is no
partial-success path: a malformed input always throws before any part of a
document is returned, never a half-built one. It rejects:

- an unknown/future `jpaint` format version (anything other than
  `JPAINT_FORMAT_VERSION`);
- a missing required field, at the document level or on any individual event;
- a `pixels` value that doesn't decode to exactly `width × height × 4` bytes (4
  bytes per `Int32Array` pixel) — a truncated or corrupt buffer is rejected
  outright rather than silently treated as a smaller canvas;
- malformed base64 in `pixels` or in any event's `cells`;
- JSON that fails to parse, or that parses to something other than an object.

See `tests/jpaint_test.ts` for the golden-fixture round-trip
(`tests/fixtures/sample.jpaint.json`, decoded and checked field-by-field, then
re-encoded via `buildJpaintDocument()` and diffed byte-for-byte against the same
fixture — so the fixture catches drift in either direction, not just in
whichever function happened to produce it) and one test per rejection path
above.

## Mapping to the mod's `.paint` format

For a future converter targeting the source mod's persisted `.paint` NBT fields
(`docs/joy-of-painting-interface-spec.md`'s "Persistent canvas data" section),
here is what's derivable from a `.jpaint` document today and what is not:

| `.paint` field                                                 | Derivable from `.jpaint`? | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| -------------------------------------------------------------- | ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pixels` (`int[]`)                                             | Yes                       | Decode `pixels`, or recompute via `composeCanvas(events)` — both are the same signed-32-bit-ARGB representation, just base64-wrapped here.                                                                                                                                                                                                                                                                                                                                                                                   |
| `ct` (canvas type code)                                        | Yes                       | `(width, height)` maps 1:1 to the mod's 4 type codes (16×16→0, 32×32→1, 32×16→2, 16×32→3) per the interface spec's table. Every `.jpaint` document produced by this app today has `ct` 0, since only the 16×16 type is implemented.                                                                                                                                                                                                                                                                                          |
| `glass` (boolean)                                              | **No**                    | This app has no glass/opaque canvas distinction anywhere in `paint-engine.js` — every canvas is implicitly opaque. Not a missing field, a missing feature; would need real paint-engine work (glass fill/clear semantics, per `docs/joy-of-painting-interface-spec.md`'s "Cell types" section) before it could mean anything here.                                                                                                                                                                                           |
| `title`                                                        | Yes                       | Direct.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `author`                                                       | Yes                       | Direct, as of Phase 3.5 — captured at signing time, not a live join (see the schema comment on `canvases.author`).                                                                                                                                                                                                                                                                                                                                                                                                           |
| `name` (canvas id)                                             | Yes                       | Our `id` already serves this role under a different field name; not a missing capability.                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `v` (version, "increment whenever the client commits an edit") | **No**                    | `canvas_events.sequence` is `INTEGER PRIMARY KEY AUTOINCREMENT` — **global** across every canvas's events, with arbitrary gaps and no per-canvas zero point. It is not, and cannot be treated as, a per-canvas edit counter. A real `v` would need a new per-canvas counter column (or `COUNT(*) FROM canvas_events WHERE canvas_id = ?`, which only approximates "edits" and depends on matching the mod's exact per-edit granularity, which hasn't been verified). Not implemented; flagged here rather than approximated. |
| `generation` (0 unsigned / 1 original / 2+ copies)             | **No**                    | There is no painting-copy feature in this app at all — nothing to derive `generation` FROM. Building it would mean a new "duplicate this painting" route, a `generation` column, and real product decisions (does a copy consume the signer's one-draft slot? does it keep the original's author?). A feature, not a field.                                                                                                                                                                                                  |

## Content type

`GET /canvases/:id/jpaint` responds with
`content-type:
application/x-jpaint+json`, not `application/json`. This is a
distinct media type, not "JSON with a custom extension" — a `.jpaint` document
has format-specific validity rules (`decodeJpaintDocument()`'s rejections above)
that a generic JSON consumer doesn't know about, and the header is what lets a
client, or a future browser file-open flow, tell the two apart without sniffing
the body. `Response.json()` hardcodes `application/json` and can't override it,
so the route builds the response with
`new Response(JSON.stringify(document), { headers: {
"content-type": "application/x-jpaint+json", ... } })`
instead.

## Including or omitting the event log: `?events=none`

The route defaults to including the full event log, and accepts `?events=none`
to omit it (the response still carries an `events: []` array — the field's
presence and shape don't change, only its contents).

**Default is full-log-included.** Reasoning: `.jpaint`'s entire purpose is
archival fidelity (see "Losslessness guarantee" above), and defaulting to a
truncated response would mean the common case — someone fetching the URL
directly, or a caller that doesn't know to ask for more — silently gets the
lossy option. `?events=none` exists for a caller who explicitly only wants the
finished image and would rather not pay for a long edit history over the wire;
that's an opt-in, not the default.

**Cache-key safety, verified rather than assumed:** this route is publicly
cached (`cache-control: public, max-age=3600` and
`deno-cdn-cache-control:
public, s-maxage=86400`), and two different response
shapes on one path only works if the query string participates in the cache key.
What was established:

- Deno Deploy's own caching documentation states its edge cache follows RFC
  9110/9111 HTTP semantics. Under RFC 9111, the cache key is the request's
  method plus its full target URI — which includes the query string — so
  `?events=none` and the no-query default are, by definition, different cache
  entries; this is standard behavior for a spec-compliant HTTP cache, not a
  Deno-specific quirk. (The docs don't spell out query strings explicitly, so
  this is "confirmed the cache follows the spec that guarantees it," not "found
  an explicit query-string statement.")
- There is in-repo precedent for exactly this pattern already:
  `/api/completed-feed` is publicly cached
  (`cache-control: public,
  max-age=2, ...`) and already varies its response by
  `limit`/`cursor` query params with no special cache-key handling — that route
  would be visibly broken (stale/wrong pages served across different cursors) if
  query strings didn't participate in the cache key, and it isn't.
- Browser HTTP caching (the plain `cache-control` header, independent of Deno
  Deploy's CDN) has always keyed on the full URL including query string; this
  part needed no verification.

No code change was needed to make this safe — it already was, by how HTTP
caching is specified. The query flag was simply free to add.

## Filename: the painting's title

The route sends the title as the filename, sanitized, with both parameters RFC
6266 defines:

```
content-disposition: attachment; filename="Blue Armadillo.jpaint";
                     filename*=UTF-8''Blue%20Armadillo.jpaint
```

An earlier revision used the canvas id alone, to avoid sanitizing user text.
That was the wrong trade: a ULID in a downloads folder tells the user nothing
about which painting they just saved.

Sanitizing is genuinely required, because `validateCompletion()` in
`src/server/protocol.ts` constrains a title only to a trimmed string of 1-16
code points — there is no charset restriction at all. A title may therefore
contain path separators, Windows-illegal characters, control characters, a
leading dot, `..`, a reserved device name such as `NUL`, or any Unicode.
`src/server/content-disposition.ts` handles each case, and falls back to the
canvas id when nothing usable survives; a meaningless-but-valid filename beats a
broken download.

The `filename*` parameter carries the real title, percent-encoded as UTF-8, so a
painting titled with emoji or in a non-Latin script still downloads under a
meaningful name. Every current browser prefers it; the quoted ASCII `filename`
remains for older clients.

## Owner-scoped draft export: not built

The public route 404s an unsigned draft, matching `/replay`'s behavior — that
part is unchanged. Separately considered and **not built**: a route letting a
draft's owner export their own in-progress work before signing. Arguments for it
are real (a user's only copy of an in-progress painting is otherwise trapped
until they sign or lose it), but it was left undone here because it is not a
small extension of the same route:

- A draft has no stored `pixels` snapshot to read — `canvases.pixels` is only
  written by `storeCanvasPixels()` at signing time
  (`UPDATE canvases
  SET pixels = ? WHERE id = ? AND completed_at IS NOT NULL`).
  A draft export would need to compose the image from the event log on the fly
  (`composeCanvas()`, the same approach `withComposedPixels()` uses for the live
  display feed), a different code path from the signed route.
- It needs real auth (owner-only, via `guestSession()`), not just the existing
  "is this canvas completed" check.
- It raises its own product questions that weren't posed for the signed case: is
  the export a live snapshot of a still-mutating canvas (so two exports five
  seconds apart can legitimately differ), does `author` read as `null` (nothing
  has signed it yet) or as the owner's current handle, and does `completedAt`
  read as `null` or should the field be omitted entirely for a draft.

None of that is hard, but it's meaningfully more than "add a flag to the
existing route," and a half-considered version of it would be worse than waiting
for someone to actually ask for it with those questions answered. If it's
wanted, it belongs as its own follow-up with those three questions settled
first.

## Import: open questions (not code, decisions for the user)

`.jpaint` decoding exists now (`decodeJpaintDocument()`), but there is no import
route, and this section deliberately does not propose one. Before any
`POST /canvases/import`-shaped endpoint gets built, these need actual product
decisions, not engineering defaults:

- **What is `generation` on an imported painting?** This app has no `generation`
  column and no copy/duplicate feature (see the mapping table above). An import
  is, in effect, a copy of _something_ — either a re-import of this app's own
  prior export, or eventually a `.paint` file from the mod. Does importing mint
  a new id (making the import a fresh, unrelated painting), or does it need to
  record where it came from?
- **Does an import consume the single-draft slot?** `canvases_owner_draft_idx`
  is a partial unique index enforcing exactly one open (unsigned) draft per
  owner — the user has said repeatedly, and this is not up for revisiting, that
  the app never offers multiple simultaneous drafts. An import that lands as a
  new draft must go through the same one-slot rule as any other draft (blocked,
  or replacing the existing draft, the same way starting a new painting already
  works today) — it must not become a second way to end up with two open drafts.
- **Who becomes the author of an imported painting?** The importing
  guest/account, unconditionally? Or, if the file's own `author` field is
  trusted, whatever it says (which would let an imported file claim authorship
  it can't prove — the same "don't trust a client-supplied author" reasoning
  that already made `/canvases/:id/complete` ignore a posted `author` field and
  derive it server-side applies here too)?

`v` and `generation` are listed here as explicitly **not derivable from our
current model**, not as "future work that's basically done" — that distinction
is the point of this table.
