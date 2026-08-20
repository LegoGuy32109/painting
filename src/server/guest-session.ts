const COOKIE_NAME = "painting_guest";
const COOKIE_VERSION = "v1";
const COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 400;

const fallbackSecret = crypto.getRandomValues(new Uint8Array(32));
let keyPromise: Promise<CryptoKey> | null = null;

function signingSecret(): ArrayBuffer {
  try {
    const configured = Deno.env.get("GUEST_SESSION_SECRET");
    if (!configured) {
      throw new Error("GUEST_SESSION_SECRET must be set");
    }
    const bytes = new TextEncoder().encode(configured);
    if (bytes.byteLength < 32) {
      throw new Error("GUEST_SESSION_SECRET must contain at least 32 bytes");
    }
    return bytes.buffer;
  } catch (error) {
    if (
      !(error instanceof Deno.errors.PermissionDenied) &&
      !(error instanceof Deno.errors.NotCapable)
    ) throw error;
  }
  return fallbackSecret.buffer;
}

function signingKey(): Promise<CryptoKey> {
  return keyPromise ??= crypto.subtle.importKey(
    "raw",
    signingSecret(),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

export function assertGuestSessionConfigured(): void {
  signingSecret();
}

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(
    /=+$/,
    "",
  );
}

function fromBase64Url(value: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return null;
  try {
    const padded = value.replaceAll("-", "+").replaceAll("_", "/")
      .padEnd(Math.ceil(value.length / 4) * 4, "=");
    return Uint8Array.from(
      atob(padded),
      (character) => character.charCodeAt(0),
    );
  } catch {
    return null;
  }
}

async function signGuestId(guestId: string): Promise<string> {
  const signature = await crypto.subtle.sign(
    "HMAC",
    await signingKey(),
    new TextEncoder().encode(`${COOKIE_VERSION}.${guestId}`),
  );
  return `${COOKIE_VERSION}.${guestId}.${base64Url(new Uint8Array(signature))}`;
}

async function verifyToken(token: string): Promise<string | null> {
  const [version, guestId, signatureValue, extra] = token.split(".");
  if (
    version !== COOKIE_VERSION || extra !== undefined ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
      .test(guestId)
  ) return null;
  const signature = fromBase64Url(signatureValue);
  if (!signature) return null;
  const valid = await crypto.subtle.verify(
    "HMAC",
    await signingKey(),
    signature.buffer as ArrayBuffer,
    new TextEncoder().encode(`${version}.${guestId}`),
  );
  return valid ? guestId : null;
}

function cookieValue(req: Request): string | null {
  const cookie = req.headers.get("cookie");
  if (!cookie) return null;
  for (const part of cookie.split(";")) {
    const [name, ...value] = part.trim().split("=");
    if (name === COOKIE_NAME) return value.join("=");
  }
  return null;
}

export interface GuestSession {
  guestId: string;
  setCookie: string | null;
}

export async function guestSession(
  req: Request,
  create: boolean,
): Promise<GuestSession | null> {
  const token = cookieValue(req);
  if (token) {
    const guestId = await verifyToken(token);
    if (guestId) return { guestId, setCookie: null };
  }
  if (!create) return null;

  const guestId = crypto.randomUUID();
  const nextToken = await signGuestId(guestId);
  const secure = new URL(req.url).protocol === "https:" ? "; Secure" : "";
  return {
    guestId,
    setCookie:
      `${COOKIE_NAME}=${nextToken}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${COOKIE_MAX_AGE_SECONDS}${secure}`,
  };
}

export function withSessionCookie(
  response: Response,
  session: GuestSession,
): Response {
  if (!session.setCookie) return response;
  const headers = new Headers(response.headers);
  headers.append("set-cookie", session.setCookie);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
