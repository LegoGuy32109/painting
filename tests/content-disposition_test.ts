import { assertEquals, assertMatch, assertStringIncludes } from "@std/assert";
import {
  attachmentDisposition,
  encodeExtValue,
  sanitizeFilenameStem,
} from "../src/server/content-disposition.ts";

const ID = "01M10CHRRCMS63DAQ85KX0QXMV";

Deno.test("an ordinary title becomes the filename", () => {
  const header = attachmentDisposition("Blue Armadillo", ID, ".jpaint");
  assertStringIncludes(header, `filename="Blue Armadillo.jpaint"`);
  assertStringIncludes(header, `filename*=UTF-8''Blue%20Armadillo.jpaint`);
});

// validateCompletion() enforces only "trimmed string, 1-16 code points" —
// there is no charset restriction, so every one of these is a title a user
// can genuinely sign a painting with.
Deno.test("path separators cannot escape into the filename", () => {
  for (const title of ["../../etc/passwd", "a/b", "a\\b", "..", "."]) {
    const stem = sanitizeFilenameStem(title);
    if (stem !== null) {
      assertEquals(stem.includes("/"), false, `slash survived: ${title}`);
      assertEquals(stem.includes("\\"), false, `backslash survived: ${title}`);
      assertMatch(stem, /^[^.\s].*[^.\s]$|^[^.\s]$/, `dot-edged: ${title}`);
    }
  }
  // A title of only dots and separators leaves nothing, so the id is used.
  const header = attachmentDisposition("../..", ID, ".jpaint");
  assertStringIncludes(header, `filename="${ID}.jpaint"`);
});

Deno.test("Windows-illegal characters and control characters are replaced", () => {
  const stem = sanitizeFilenameStem('a:b*c?d"e<f>g|h');
  assertEquals(stem, "a-b-c-d-e-f-g-h");
  assertEquals(sanitizeFilenameStem("line\nbreak"), "line break");
  assertEquals(sanitizeFilenameStem("tab\tsep"), "tab sep");
  assertEquals(sanitizeFilenameStem("null\u0000byte"), "null byte");
});

Deno.test("Windows reserved device names fall back to the id", () => {
  for (const reserved of ["NUL", "nul", "CON", "com1", "LPT9", "AuX"]) {
    assertEquals(sanitizeFilenameStem(reserved), null, reserved);
    assertStringIncludes(
      attachmentDisposition(reserved, ID, ".jpaint"),
      `filename="${ID}.jpaint"`,
    );
  }
  // Only the exact basename is reserved; a longer name containing it is fine.
  assertEquals(sanitizeFilenameStem("console"), "console");
});

Deno.test("a non-ASCII title keeps its characters in filename* and falls back in filename", () => {
  const header = attachmentDisposition("🎨 Sunset", ID, ".jpaint");
  // The ASCII fallback drops the emoji but keeps the usable remainder.
  assertStringIncludes(header, `filename="Sunset.jpaint"`);
  // filename* carries the real title, percent-encoded as UTF-8 bytes.
  assertStringIncludes(header, `filename*=UTF-8''%F0%9F%8E%A8%20Sunset.jpaint`);

  // A title that is entirely non-ASCII leaves no ASCII stem at all.
  const cjk = attachmentDisposition("日本語", ID, ".jpaint");
  assertStringIncludes(cjk, `filename="${ID}.jpaint"`);
  assertStringIncludes(
    cjk,
    `filename*=UTF-8''%E6%97%A5%E6%9C%AC%E8%AA%9E.jpaint`,
  );
});

Deno.test("a quote in a title cannot break out of the quoted filename", () => {
  const header = attachmentDisposition('say "hi"', ID, ".jpaint");
  const quoted = header.match(/filename="([^"]*)"/);
  // The substituted trailing hyphen is stripped from the edge, the same
  // way a trailing dot or space would be.
  assertEquals(quoted?.[1], "say -hi.jpaint");
  // Exactly one quoted parameter — no stray quotes split the header.
  assertEquals(header.split('"').length - 1, 2);
});

Deno.test("a semicolon in a title cannot inject a header parameter", () => {
  const header = attachmentDisposition("a;b=c", ID, ".jpaint");
  assertStringIncludes(header, `filename="a;b=c.jpaint"`);
  // The ext-value must not carry a raw semicolon or equals sign.
  const extValue = header.split("filename*=UTF-8''")[1];
  assertEquals(extValue.includes(";"), false);
  assertEquals(extValue.includes("="), false);
});

Deno.test("an untitled painting uses the id for both parameters", () => {
  const header = attachmentDisposition(null, ID, ".jpaint");
  assertStringIncludes(header, `filename="${ID}.jpaint"`);
  assertStringIncludes(header, `filename*=UTF-8''${ID}.jpaint`);
});

Deno.test("encodeExtValue leaves attr-chars alone and encodes the rest", () => {
  // RFC 5987's attr-char set includes "~", "!", "#", "$", "&", "+", "-",
  // ".", "^", "_", "`" and "|", so none of those need encoding.
  assertEquals(encodeExtValue("abcXYZ012-._~"), "abcXYZ012-._~");
  assertEquals(encodeExtValue(" "), "%20");
  assertEquals(encodeExtValue("'"), "%27");
  assertEquals(encodeExtValue("("), "%28");
  assertEquals(encodeExtValue("*"), "%2A");
});
