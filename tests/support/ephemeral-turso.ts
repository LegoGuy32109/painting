const API_BASE = "https://api.turso.tech/v1";

export interface EphemeralDatabase {
  name: string;
  url: string;
  token: string;
  remove(): Promise<void>;
}

export async function createEphemeralDatabase(
  purpose = "browser",
): Promise<EphemeralDatabase> {
  const apiKey = requireEnv("TURSO_API_KEY");
  const orgSlug = requireEnv("TURSO_ORG_SLUG");
  const name = `painting-test-${purpose}-${slug()}`.slice(0, 63);

  async function api(path: string, options: RequestInit = {}) {
    const response = await fetch(`${API_BASE}${path}`, {
      ...options,
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
        ...options.headers,
      },
    });
    if (!response.ok) {
      throw new Error(
        `${
          options.method ?? "GET"
        } ${path} -> ${response.status}: ${await response.text()}`,
      );
    }
    return response.json();
  }

  const created = await api(`/organizations/${orgSlug}/databases`, {
    method: "POST",
    body: JSON.stringify({ name, group: "default", use_tursodb: true }),
  });
  const tokenResponse = await api(
    `/organizations/${orgSlug}/databases/${name}/auth/tokens?expiration=never&authorization=full-access`,
    { method: "POST" },
  );
  return {
    name,
    url: `libsql://${created.database.Hostname}`,
    token: tokenResponse.jwt,
    async remove() {
      await api(`/organizations/${orgSlug}/databases/${name}`, {
        method: "DELETE",
      });
    },
  };
}

function requireEnv(name: string): string {
  const value = Deno.env.get(name);
  if (!value) throw new Error(`${name} must be set`);
  return value;
}

function slug(): string {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}
