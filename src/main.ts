import { handler } from "./server/main.ts";
import { assertSigningKeysConfigured } from "./server/signing-keys.ts";

assertSigningKeysConfigured();
const configuredPort = Number(Deno.env.get("PORT") ?? "8000");
Deno.serve({ automaticCompression: true, port: configuredPort }, handler);
