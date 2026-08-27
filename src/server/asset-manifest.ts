// Content-addressed asset URLs, computed once and cached for the life of the
// process. Replaces the old hand-bumped `?v=N` scheme entirely: a hashed URL
// is immutable-cacheable *because* the URL is derived from the content, so
// there is nothing to remember to bump and nothing that can drift out of
// sync between an importer and the module it imports (see the phase notes
// in AGENTS.md / the Phase 0.5 plan for the bug class this replaces).
//
// The route lists below (CLIENT_JS_FILES / SHARED_JS_FILES / CSS_FILES) are
// deliberately NOT auto-discovered by scanning the directories: main.ts's
// existing per-route allowlists are kept as the single source of truth for
// WHICH files are served, and this module mirrors them. Adding a new served
// file means updating both places, same as it always has.

const CLIENT_JS_FILES = [
  "app.js",
  "sync.js",
  "local-db.js",
  "live-replay.js",
  "live-stream-message.js",
  "site-nav.js",
  "painting-parade.js",
  "parade-state.js",
  "collection-page.js",
  "editor-page.js",
  "pwa.js",
  "passkey.js",
];

const SHARED_JS_FILES = [
  "paint-engine.js",
  "palette-engine.js",
  "ulid.js",
  "cell-codec.js",
  "compose.js",
  "pixel-render.js",
  "transfer-code.js",
];

const CSS_FILES = ["base.css", "style.css", "gallery.css", "collection.css"];

const JS_CONTENT_TYPE = "application/javascript; charset=utf-8";
const CSS_CONTENT_TYPE = "text/css; charset=utf-8";

export type AssetKind = "client" | "shared" | "css";

export interface AssetManifestEntry {
  kind: AssetKind;
  /** The plain, never-changing path source code and HTML always reference. */
  logicalPath: string;
  /** Content-addressed path actually served in production. Equals logicalPath in dev mode. */
  hashedPath: string;
  contentType: string;
  /** The file this entry's bytes are read from. */
  sourceUrl: URL;
}

export interface AssetManifest {
  entries: AssetManifestEntry[];
  byLogicalPath: Map<string, AssetManifestEntry>;
  byHashedPath: Map<string, AssetManifestEntry>;
  /** A hash over the whole manifest. Changes if any served file's content changes. */
  manifestDigest: string;
  /** True when this is the dev identity manifest (hashedPath === logicalPath everywhere). */
  devMode: boolean;
}

const clientFile = (name: string) =>
  new URL(`../client/${name}`, import.meta.url);
const sharedFile = (name: string) =>
  new URL(`../shared/${name}`, import.meta.url);
const publicFile = (name: string) =>
  new URL(`../../public/${name}`, import.meta.url);

/** Full-length lowercase hex SHA-256 of `bytes`. Pure and exported for tests. */
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    bytes.buffer as ArrayBuffer,
  );
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

/** The first 8 hex chars of `contentHash(bytes)` — what actually goes in a hashed URL. */
export async function contentHash(bytes: Uint8Array): Promise<string> {
  return (await sha256Hex(bytes)).slice(0, 8);
}

/** Inserts `hash` immediately before a logical path's file extension. */
export function hashedPathFor(logicalPath: string, hash: string): string {
  const lastDot = logicalPath.lastIndexOf(".");
  return `${logicalPath.slice(0, lastDot)}.${hash}${
    logicalPath.slice(lastDot)
  }`;
}

/**
 * A stable hash over a whole manifest's logical→hashed mapping. Changes if
 * any served file's content changes (which changes its hashedPath) or if a
 * file is added/removed. Pure and exported for tests; sorted so entry order
 * doesn't affect the result.
 */
export async function digestManifest(
  entries: Array<{ logicalPath: string; hashedPath: string }>,
): Promise<string> {
  const parts = entries.map((e) => `${e.logicalPath}:${e.hashedPath}`).sort();
  return await sha256Hex(new TextEncoder().encode(parts.join("\n")));
}

interface FileSpec {
  kind: AssetKind;
  logicalPath: string;
  contentType: string;
  sourceUrl: URL;
}

function fileSpecs(): FileSpec[] {
  const specs: FileSpec[] = [];
  for (const name of CLIENT_JS_FILES) {
    specs.push({
      kind: "client",
      logicalPath: `/${name}`,
      contentType: JS_CONTENT_TYPE,
      sourceUrl: clientFile(name),
    });
  }
  for (const name of SHARED_JS_FILES) {
    specs.push({
      kind: "shared",
      logicalPath: `/shared/${name}`,
      contentType: JS_CONTENT_TYPE,
      sourceUrl: sharedFile(name),
    });
  }
  for (const name of CSS_FILES) {
    specs.push({
      kind: "css",
      logicalPath: `/${name}`,
      contentType: CSS_CONTENT_TYPE,
      sourceUrl: publicFile(name),
    });
  }
  return specs;
}

/**
 * Reads and SHA-256 hashes every served client/shared/css file to build the
 * content-addressed manifest. In dev mode, skips hashing entirely and
 * returns an identity map (hashedPath === logicalPath) so file edits are
 * visible on the next request with no restart.
 */
export async function computeAssetManifest(
  devMode: boolean,
): Promise<AssetManifest> {
  const specs = fileSpecs();
  const entries: AssetManifestEntry[] = [];

  for (const spec of specs) {
    let hashedPath = spec.logicalPath;
    if (!devMode) {
      const bytes = await Deno.readFile(spec.sourceUrl);
      const hash = await contentHash(bytes);
      hashedPath = hashedPathFor(spec.logicalPath, hash);
    }
    entries.push({
      kind: spec.kind,
      logicalPath: spec.logicalPath,
      hashedPath,
      contentType: spec.contentType,
      sourceUrl: spec.sourceUrl,
    });
  }

  entries.sort((a, b) => a.logicalPath.localeCompare(b.logicalPath));
  const manifestDigest = devMode ? "dev" : await digestManifest(entries);

  return {
    entries,
    byLogicalPath: new Map(entries.map((entry) => [entry.logicalPath, entry])),
    byHashedPath: new Map(entries.map((entry) => [entry.hashedPath, entry])),
    manifestDigest,
    devMode,
  };
}

let manifestPromise: Promise<AssetManifest> | null = null;

/**
 * Lazily computes and caches the manifest for the life of the process — the
 * first request pays the hashing cost, every request after is a map lookup.
 * Dev mode is cheap to cache too (it's a fixed identity map); actual file
 * content is still read fresh per request by the caller, so dev edits are
 * always visible without a restart.
 */
export function getAssetManifest(devMode: boolean): Promise<AssetManifest> {
  return manifestPromise ??= computeAssetManifest(devMode);
}

export async function readAsset(
  entry: AssetManifestEntry,
): Promise<Uint8Array<ArrayBuffer>> {
  return await Deno.readFile(entry.sourceUrl);
}

/**
 * Builds the `{ "imports": { ... } }` object for a `<script type="importmap">`.
 * Includes every served JS module (client + shared), not just <script src>
 * entry points, since only specifiers present in the map get redirected to
 * their hashed URL — an unmapped relative import would otherwise still
 * resolve to the (unhashed, in prod: 404ing) logical path.
 */
export function buildImportMap(
  manifest: AssetManifest,
): { imports: Record<string, string> } {
  const imports: Record<string, string> = {};
  for (const entry of manifest.entries) {
    if (entry.kind === "client" || entry.kind === "shared") {
      imports[entry.logicalPath] = entry.hashedPath;
    }
  }
  return { imports };
}
