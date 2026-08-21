export interface DatabaseEnvironment {
  label: "Production" | "Preview" | "Development";
  database: "painting-prod" | "painting-dev";
}

/**
 * Preview and Development are separate user-facing deployment targets. They
 * currently both use painting-dev, while the Deno Deploy API presents the
 * dev-branch timeline as Preview.
 */
export function parseDatabaseEnvironment(
  value: string | undefined,
): DatabaseEnvironment {
  switch (value?.toLowerCase()) {
    case "prod":
    case "production":
      return { label: "Production", database: "painting-prod" };
    case "preview":
      return { label: "Preview", database: "painting-dev" };
    case "development":
    case "dev":
      return { label: "Development", database: "painting-dev" };
    default:
      throw new Error("expected environment: Prod, Preview, or Development");
  }
}

interface DatabaseCredentials {
  url: string;
  token: string;
}

function explicitCredentials(
  environment: DatabaseEnvironment,
): DatabaseCredentials | null {
  const url = Deno.env.get("TURSO_DB_URL");
  const token = Deno.env.get("TURSO_DB_TOKEN");
  if (url && token) {
    if (url.startsWith(`libsql://${environment.database}-`)) {
      return { url, token };
    }
    // .env normally holds painting-local credentials. They are not an error
    // when the requested target is another environment; use the admin path.
    return null;
  }
  if (url || token) {
    throw new Error("TURSO_DB_URL and TURSO_DB_TOKEN must be set together");
  }
  return null;
}

async function adminCredentials(
  environment: DatabaseEnvironment,
): Promise<DatabaseCredentials> {
  const apiKey = Deno.env.get("TURSO_API_KEY");
  const org = Deno.env.get("TURSO_ORG_SLUG");
  if (!apiKey || !org) {
    throw new Error(
      "set TURSO_API_KEY and TURSO_ORG_SLUG, or matching TURSO_DB_URL and TURSO_DB_TOKEN",
    );
  }
  const headers = { Authorization: `Bearer ${apiKey}` };
  const databases = await fetch(
    `https://api.turso.tech/v1/organizations/${org}/databases`,
    { headers },
  );
  if (!databases.ok) {
    throw new Error(`could not list Turso databases: ${databases.status}`);
  }
  const result = await databases.json();
  const database = result.databases.find((entry: { Name: string }) =>
    entry.Name === environment.database
  );
  if (!database?.Hostname) {
    throw new Error(`${environment.database} does not exist in Turso`);
  }

  // Turso's management endpoint returns a database JWT here. Its value is
  // kept only in this process and never logged or written to disk, although
  // Turso records the issued token server-side.
  const tokenResponse = await fetch(
    `https://api.turso.tech/v1/organizations/${org}/databases/${environment.database}/auth/tokens?expiration=never&authorization=full-access`,
    { method: "POST", headers },
  );
  if (!tokenResponse.ok) {
    throw new Error(
      `could not mint ${environment.database} access token: ${tokenResponse.status}`,
    );
  }
  const tokenResult = await tokenResponse.json();
  if (!tokenResult.jwt) {
    throw new Error(
      `Turso did not return an access token for ${environment.database}`,
    );
  }
  return { url: `libsql://${database.Hostname}`, token: tokenResult.jwt };
}

export async function openEnvironmentDatabase(
  environment: DatabaseEnvironment,
): Promise<Client> {
  const credentials = explicitCredentials(environment) ??
    await adminCredentials(environment);
  return createClient({ url: credentials.url, authToken: credentials.token });
}

export function backupFileName(environment: DatabaseEnvironment): string {
  const timestamp = new Date().toISOString().replaceAll(":", "-");
  return `backups/${environment.database}-${timestamp}.json`;
}
import { type Client, createClient } from "@tursodatabase/serverless/compat";
