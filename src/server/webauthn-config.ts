// The relying-party (RP) configuration for passkey registration, pinned
// from the environment rather than derived from request headers.
//
// A WebAuthn credential is bound forever to the RP ID it was registered
// under. Deriving rpID from `Host`/`X-Forwarded-Host` (as a prior project
// this one's author worked on did) means every distinct origin this app is
// ever served from — production, each branch preview, localhost — mints
// credentials under a DIFFERENT RP ID, and a passkey registered on a
// preview is then permanently unusable in production with no actionable
// error. See RELATED-ORIGIN-REQUESTS.md at the repo root for the full
// rationale and the Related Origin Requests feature this defers.
//
// Instead: WEBAUTHN_RP_ID and WEBAUTHN_ORIGINS are fixed per deployment
// context (see docs/deno-deploy-env-vars.md for how contexts get distinct
// values), and every account route hard-gates on them — see
// requireRelyingParty() below.

import { HttpError } from "./protocol.ts";

export interface RelyingParty {
  rpId: string;
  rpName: string;
  /** The exact, allowlisted origins passkey ceremonies are permitted from. */
  expectedOrigins: string[];
}

const RP_NAME = "Joy of Painting";

/** Returns null when WEBAUTHN_RP_ID / WEBAUTHN_ORIGINS aren't configured — see requireRelyingParty(). */
export function relyingParty(): RelyingParty | null {
  const rpId = Deno.env.get("WEBAUTHN_RP_ID");
  const originsRaw = Deno.env.get("WEBAUTHN_ORIGINS");
  if (!rpId || !originsRaw) return null;
  const expectedOrigins = originsRaw
    .split(",")
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0);
  if (expectedOrigins.length === 0) return null;
  return { rpId, rpName: RP_NAME, expectedOrigins };
}

/**
 * The 501 gate every account route (src/server/main.ts's /api/auth/* and
 * /api/me/handle) calls first. Guest profiles work everywhere regardless —
 * this only gates the passkey/account surface, never guest painting.
 *
 * 501 (Not Implemented), not 403: this isn't a permissions problem the
 * caller could fix by authenticating differently — the feature genuinely
 * isn't available on this origin, the same way a route that doesn't exist
 * yet would 501, and it lets the client tell the two cases apart from a
 * real rejection.
 */
export function requireRelyingParty(req: Request): RelyingParty {
  const rp = relyingParty();
  if (!rp) {
    throw new HttpError(
      501,
      "accounts are only available on the canonical domain",
    );
  }
  const requestOrigin = req.headers.get("origin") ?? new URL(req.url).origin;
  if (!rp.expectedOrigins.includes(requestOrigin)) {
    throw new HttpError(
      501,
      "accounts are only available on the canonical domain",
    );
  }
  return rp;
}
