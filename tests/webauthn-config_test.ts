import { assertEquals, assertThrows } from "@std/assert";
import {
  relyingParty,
  requireRelyingParty,
} from "../src/server/webauthn-config.ts";
import { HttpError } from "../src/server/protocol.ts";

function withEnv<T>(vars: Record<string, string | undefined>, fn: () => T): T {
  const previous = new Map<string, string | undefined>();
  for (const key of Object.keys(vars)) previous.set(key, Deno.env.get(key));
  try {
    for (const [key, value] of Object.entries(vars)) {
      if (value === undefined) Deno.env.delete(key);
      else Deno.env.set(key, value);
    }
    return fn();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) Deno.env.delete(key);
      else Deno.env.set(key, value);
    }
  }
}

Deno.test("relyingParty returns null when either env var is unset", () => {
  withEnv(
    { WEBAUTHN_RP_ID: undefined, WEBAUTHN_ORIGINS: undefined },
    () => {
      assertEquals(relyingParty(), null);
    },
  );
  withEnv(
    { WEBAUTHN_RP_ID: "example.test", WEBAUTHN_ORIGINS: undefined },
    () => {
      assertEquals(relyingParty(), null);
    },
  );
  withEnv(
    { WEBAUTHN_RP_ID: undefined, WEBAUTHN_ORIGINS: "https://example.test" },
    () => {
      assertEquals(relyingParty(), null);
    },
  );
});

Deno.test("relyingParty parses a comma-separated origin allowlist", () => {
  withEnv(
    {
      WEBAUTHN_RP_ID: "example.test",
      WEBAUTHN_ORIGINS: "https://example.test, https://www.example.test ,",
    },
    () => {
      const rp = relyingParty();
      assertEquals(rp?.rpId, "example.test");
      assertEquals(rp?.rpName, "Joy of Painting");
      assertEquals(rp?.expectedOrigins, [
        "https://example.test",
        "https://www.example.test",
      ]);
    },
  );
});

Deno.test("requireRelyingParty 501s when config is unset", () => {
  withEnv(
    { WEBAUTHN_RP_ID: undefined, WEBAUTHN_ORIGINS: undefined },
    () => {
      const error = assertThrows(
        () =>
          requireRelyingParty(
            new Request("https://example.test/api/auth/register/options"),
          ),
        HttpError,
      );
      assertEquals(error.status, 501);
    },
  );
});

Deno.test("requireRelyingParty 501s when the request origin isn't allowlisted", () => {
  withEnv(
    {
      WEBAUTHN_RP_ID: "example.test",
      WEBAUTHN_ORIGINS: "https://example.test",
    },
    () => {
      const error = assertThrows(
        () =>
          requireRelyingParty(
            new Request("https://example.test/api/auth/register/options", {
              headers: { origin: "https://preview-123.deno.dev" },
            }),
          ),
        HttpError,
      );
      assertEquals(error.status, 501);
    },
  );
});

Deno.test("requireRelyingParty succeeds for an allowlisted origin", () => {
  withEnv(
    {
      WEBAUTHN_RP_ID: "example.test",
      WEBAUTHN_ORIGINS: "https://example.test",
    },
    () => {
      const rp = requireRelyingParty(
        new Request("https://example.test/api/auth/register/options", {
          headers: { origin: "https://example.test" },
        }),
      );
      assertEquals(rp.rpId, "example.test");
    },
  );
});

Deno.test("requireRelyingParty falls back to the request URL's own origin when no Origin header is sent", () => {
  withEnv(
    {
      WEBAUTHN_RP_ID: "localhost",
      WEBAUTHN_ORIGINS: "http://localhost:8000",
    },
    () => {
      const rp = requireRelyingParty(
        new Request("http://localhost:8000/api/auth/register/options"),
      );
      assertEquals(rp.rpId, "localhost");
    },
  );
});
