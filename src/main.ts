import { handler } from "./server/main.ts";
import { assertGuestSessionConfigured } from "./server/guest-session.ts";

assertGuestSessionConfigured();
const configuredPort = Number(Deno.env.get("PORT") ?? "8000");
Deno.serve({ automaticCompression: true, port: configuredPort }, handler);
