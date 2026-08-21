import { assertEquals } from "@std/assert";
import { parseDatabaseEnvironment } from "../scripts/database-environment.ts";

Deno.test("database environment names select their intended database", () => {
  assertEquals(parseDatabaseEnvironment("Prod"), {
    label: "Production",
    database: "painting-prod",
  });
  assertEquals(parseDatabaseEnvironment("Preview"), {
    label: "Preview",
    database: "painting-dev",
  });
  assertEquals(parseDatabaseEnvironment("Development"), {
    label: "Development",
    database: "painting-dev",
  });
});
