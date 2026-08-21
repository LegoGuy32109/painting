import { handler } from "./server/main.ts";
import { assertGuestSessionConfigured } from "./server/guest-session.ts";

assertGuestSessionConfigured();
Deno.serve({ automaticCompression: true }, handler);
