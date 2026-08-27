// Builds a Content-Disposition header for a downloaded file whose name comes
// from user text.
//
// A painting's title is genuinely arbitrary: validateCompletion() in
// protocol.ts only requires a trimmed string of 1-16 code points, with no
// charset restriction at all. So a title can legitimately contain path
// separators, Windows-illegal characters, control characters, a leading dot,
// "..", a Windows reserved device name, or any Unicode at all. None of that
// can be allowed to reach a filesystem unfiltered.
//
// Two parameters are emitted, per RFC 6266:
//   - `filename=` — a quoted ASCII-only fallback for ancient clients.
//   - `filename*=UTF-8''...` — RFC 5987 percent-encoded, carrying the real
//     title including emoji and non-Latin scripts. Every current browser
//     prefers this one, which is why a title of "🎨" still downloads with a
//     meaningful name rather than as the bare fallback.
//
// If nothing survives sanitizing (a title that is entirely punctuation, or
// entirely non-ASCII with no `filename*` support), the caller's fallback stem
// — the canvas id — is used instead. A meaningless-but-valid name beats a
// broken download.

/** Windows reserved device basenames, which are unusable regardless of extension. */
const RESERVED_BASENAMES = new Set([
  "con",
  "prn",
  "aux",
  "nul",
  ...Array.from({ length: 9 }, (_, i) => `com${i + 1}`),
  ...Array.from({ length: 9 }, (_, i) => `lpt${i + 1}`),
]);

/**
 * Characters illegal on Windows or meaningful to a path on any platform.
 * Written out explicitly, with every non-printable escaped rather than
 * embedded literally and with no `-` ranges over printable characters: a
 * literal control byte in a regex is invisible in review and a range like
 * ` -/` silently spans 0x20-0x2F, swallowing the space and all punctuation
 * between. Either mistake quietly mangles ordinary titles instead of
 * failing loudly. Replaced, not dropped, so "a/b" reads as "a-b", not "ab".
 */
const ILLEGAL = /[/\\:*?"<>|]/g;

/** C0 and DEL control characters. Separators, so they collapse to a space. */
const CONTROL = /[\u0000-\u001F\u007F]/g;

/** Everything RFC 5987 does not allow unencoded in an ext-value. */
const ATTR_CHAR = /[A-Za-z0-9!#$&+\-.^_`|~]/;

const MAX_STEM_LENGTH = 64;

/**
 * Reduces user text to a safe ASCII filename stem, or returns null when
 * nothing usable survives.
 */
export function sanitizeFilenameStem(raw: string): string | null {
  let stem = raw
    .replace(CONTROL, " ")
    .replace(ILLEGAL, "-")
    // Drop non-ASCII: the filename* parameter carries the real characters,
    // and a mojibake fallback is worse than a plain one.
    .replace(/[^\x20-\x7E]/g, "")
    // Collapse whitespace runs (including the spaces just substituted in).
    .replace(/\s+/g, " ")
    .trim()
    // Windows silently strips trailing dots and spaces, which would turn
    // "foo..jpaint" into something the user never asked for. Strip leading
    // dots too, so a title can never produce a hidden dotfile or "..".
    .replace(/-{2,}/g, "-")
    .replace(/^[.\s-]+/, "")
    .replace(/[.\s-]+$/, "");

  if (stem.length > MAX_STEM_LENGTH) {
    stem = stem.slice(0, MAX_STEM_LENGTH).trim();
  }
  if (stem.length === 0) return null;
  if (RESERVED_BASENAMES.has(stem.toLowerCase())) return null;
  return stem;
}

/** Percent-encodes a string for an RFC 5987 `filename*` ext-value. */
export function encodeExtValue(value: string): string {
  let encoded = "";
  for (const byte of new TextEncoder().encode(value)) {
    const character = String.fromCharCode(byte);
    encoded += ATTR_CHAR.test(character)
      ? character
      : `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
  }
  return encoded;
}

/**
 * Builds an `attachment` Content-Disposition value.
 *
 * @param title User-supplied name, or null when the work is untitled.
 * @param fallbackStem Used when `title` sanitizes to nothing — the canvas id.
 * @param extension Including the leading dot, e.g. ".jpaint".
 */
export function attachmentDisposition(
  title: string | null,
  fallbackStem: string,
  extension: string,
): string {
  const sanitized = title === null ? null : sanitizeFilenameStem(title);
  const asciiStem = sanitized ?? fallbackStem;
  // The UTF-8 parameter keeps the original title when one exists, even
  // where the ASCII fallback had to drop characters to stay safe. It is
  // still sanitized for path-significant characters first — filename* is
  // not an escape hatch for "/" or a control character.
  const utf8Source = title === null
    ? fallbackStem
    : title.replace(CONTROL, " ").replace(ILLEGAL, "-").replace(/\s+/g, " ")
      .trim()
      .replace(/^[.\s]+/, "").replace(/[.\s]+$/, "") || fallbackStem;

  return `attachment; filename="${asciiStem}${extension}"; ` +
    `filename*=UTF-8''${encodeExtValue(`${utf8Source}${extension}`)}`;
}
