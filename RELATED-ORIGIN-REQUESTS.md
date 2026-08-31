# Note: Related Origin Requests (deferred)

Not implemented. Written down so the constraint is visible before someone
tries to test passkeys on a preview deployment and concludes they are broken.

## The constraint

A WebAuthn credential is bound to a single **RP ID** — a registrable domain
chosen at registration time. A passkey created for RP ID `A` cannot be used
on RP ID `B`, ever. There is no migration and no error message a user can
act on; the OS sheet simply reports that no passkey is available.

This project deploys to several origins:

- production (`WEBAUTHN_RP_ID`, the canonical domain)
- per-branch Deno Deploy previews (`painting-<hash>.deno.dev` or similar)
- `localhost` during development (a WebAuthn secure context by spec)

If the RP ID were derived from the request `Host` / `x-forwarded-host`
header — as `~/Projects/groups` does — each of those origins would mint
credentials under a *different* RP ID. A passkey registered on a preview URL
would be silently unusable in production.

## What we do instead, for now

Pin the RP ID and the accepted origins from the environment, per Deno Deploy
context, via `scripts/set-deploy-env.ts`:

    WEBAUTHN_RP_ID=joyofpainting.example
    WEBAUTHN_ORIGINS=https://joyofpainting.example

and **gate account creation off entirely** on any deployment whose origin is
not in `WEBAUTHN_ORIGINS`: the auth routes return 501 and the UI says
accounts are only available on the canonical domain. Guest profiles keep
working everywhere, so previews stay fully testable for everything except
sign-in.

## What Related Origin Requests would buy us

ROR (Chrome 128+, Safari 18+) lets one RP ID accept assertions from a listed
set of other origins. The RP serves a JSON document at:

    https://<rp-id>/.well-known/webauthn

    { "origins": ["https://preview-1.deno.dev", "https://preview-2.deno.dev"] }

Browsers that support it will then honour a `get()` / `create()` for RP ID
`joyofpainting.example` issued from any listed origin, so previews could
exercise the real sign-in path against production credentials.

## Why it is deferred

- The origin list is static, and preview URLs are per-deployment/per-branch —
  a wildcard is not permitted, so the file would need regenerating on every
  preview deploy.
- Browsers cap the number of labels (distinct eTLD+1 entries) they will
  honour, and `deno.dev` is a single label shared by every preview, which
  helps but still needs the exact origins enumerated.
- Unsupported browsers fall back to the old behaviour, so the env-gate above
  is required regardless. ROR is an addition to it, never a replacement.
- No production domain is registered yet, so there is nothing to point the
  `.well-known` document at.

## Revisit when

A canonical production domain is live and preview deployments genuinely need
to exercise passkey sign-in rather than just guest flows.

## The practical fallback we already have: transfer codes

Phase 5 added transfer codes (`docs/transfer-codes.md`) specifically as the
one piece of this problem that doesn't need ROR at all: they perform no
WebAuthn ceremony, so `POST /api/auth/transfer` / `POST /api/auth/transfer/consume`
are **not** gated behind `requireRelyingParty()` and work on every origin,
canonical or not — a preview deployment, or any non-canonical origin where
`/api/auth/register/*` and `/api/auth/login/*` correctly 501, can still move
a profile in or out via a code typed by hand. This doesn't reduce the case
for ROR (a preview still can't use an *existing* passkey), but it means
account creation being origin-gated never strands a profile: a code from
the canonical domain works everywhere.
