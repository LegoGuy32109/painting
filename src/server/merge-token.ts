// A merge token is a short-lived, stateless bearer credential binding one
// guest device's profile to the account profile it just authenticated as
// — used ONLY for POST /api/auth/merge, the dialog row of Phase 4's
// four-case merge table (see docs and main.ts). "Stateless" is the whole
// design point: issuing one writes nothing to the database (see
// POST /api/auth/login/verify), so a user who backs out of the merge
// dialog leaves NO trace anywhere — the token is simply discarded
// client-side, no server cleanup required.
//
// Signed under the "merge-token" purpose (src/server/signing-keys.ts),
// HKDF-domain-separated from "guest-session" — a merge token can never be
// mistaken for, or used as, a session cookie, and vice versa.

import { hasKid, primaryKid, signPayload, verifyPayload } from "./signing-keys.ts";

const MERGE_TOKEN_TTL_MS = 10 * 60 * 1000;
const KID_PATTERN = /^[a-z0-9]{1,16}$/;

export interface MergeTokenPayload {
  guestProfileId: string;
  accountProfileId: string;
  expiresAt: number;
}

/**
 * Binds (guestProfileId, accountProfileId) with a ~10 minute expiry. Does
 * NOT write anything to the database — the token carries everything it
 * needs in its own signed payload.
 */
export async function signMergeToken(params: {
  guestProfileId: string;
  accountProfileId: string;
  now: number;
}): Promise<string> {
  const kid = primaryKid();
  const expiresAt = params.now + MERGE_TOKEN_TTL_MS;
  const prefix =
    `v1.${kid}.${params.guestProfileId}.${params.accountProfileId}.${expiresAt}`;
  const signature = await signPayload("merge-token", prefix);
  return `${prefix}.${signature}`;
}

/**
 * Verifies signature, format, and expiry. Does NOT check whether either
 * profile still actually has an open draft — that's a live database fact
 * that can change between issuance and use (including because the token
 * was already used once), and main.ts's POST /api/auth/merge re-checks it
 * fresh against the database every time, which is also what makes a
 * replay of an already-used token a safe no-op/rejection rather than
 * something this function needs to prevent by itself.
 */
export async function verifyMergeToken(
  token: string,
  now: number,
): Promise<MergeTokenPayload | null> {
  const parts = token.split(".");
  if (parts.length !== 6) return null;
  const [version, kid, guestProfileId, accountProfileId, expiresAtValue, signature] =
    parts;
  if (version !== "v1") return null;
  if (!KID_PATTERN.test(kid) || !hasKid(kid)) return null;
  if (!guestProfileId || !accountProfileId) return null;
  if (!/^[0-9]+$/.test(expiresAtValue)) return null;
  const expiresAt = Number(expiresAtValue);
  if (!Number.isSafeInteger(expiresAt)) return null;

  const prefix =
    `v1.${kid}.${guestProfileId}.${accountProfileId}.${expiresAtValue}`;
  const valid = await verifyPayload("merge-token", prefix, kid, signature);
  if (!valid) return null;
  if (now > expiresAt) return null;

  return { guestProfileId, accountProfileId, expiresAt };
}
