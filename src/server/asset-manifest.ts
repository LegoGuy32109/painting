// Content-addressed asset URLs, computed once and cached for the life of the
// process. Replaces the old hand-bumped `?v=N` scheme entirely: a hashed URL
// is immutable-cacheable *because* the URL is derived from the content, so
// there is nothing to remember to bump and nothing that can drift out of
// sync between an importer and the module it imports (see the phase notes
// in AGENTS.md / the Phase 0.5 plan for the bug class this replaces).
//
// The served-file lists below are derived by enumerating the directories
// (see `listJsFiles` / `listCssFiles`), not hand-maintained — a new
// src/shared/*.js (or src/client/*.js, or public/*.css) file is picked up
// automatically the next time the manifest is computed. This closes the
// same maintenance gap the hashed-URL scheme itself closes: previously, a
// newly added shared module 404'd in the browser until someone remembered
// to add it to a list by hand.
//
// A small number of client files are deliberately excluded even though
// they live in the enumerated src/client/ directory — see
// EXCLUDED_CLIENT_FILES below, and main.ts's own routes for the files
// served unhashed on their own fixed paths (datastar.js,
// Minecraftia-Regular.ttf). src/shared/*.js has NO such exclusion list:
// every shared module is DOM-free domain logic that may legitimately be
// imported by browser code (see e.g. jpaint.js's own header comment on why
// it lives in src/shared/ rather than src/server/), so all of it is served
// by default. Excluding a shared file on the strength of "nothing imports
// it client-side today" would silently reintroduce the exact hand-listing
// trap this module was rewritten to remove — the first person to add a
// client-side use of it would hit a 404 instead of the file just being
// there. The cost of serving an unused module is one manifest entry and one
// hash of a small file, computed once per process; that is cheap insurance
// against a real maintenance hazard.

// sw.js and sw-routing.js are served unhashed at fixed URLs by their own
// routes in main.ts (a service worker has no import map to redirect a
// relative specifier through, and a hashed, immutably-cached service
// worker could never update itself). They must never be content-hashed or
// appear in the import map/precache list. This is a genuine, permanent
// technical constraint — unlike "nothing imports this yet" — which is why
// only src/client/ has an exclusion set.
const EXCLUDED_CLIENT_FILES = new Set(["sw.js", "sw-routing.js"]);

const clientDirectory = new URL("../client/", import.meta.url);
const sharedDirectory = new URL("../shared/", import.meta.url);
const publicDirectory = new URL("../../public/", import.meta.url);

/**
 * Sorted list of `*.js` filenames directly inside `directory`, minus
 * `excluded` (defaults to none). Sorting keeps enumeration order
 * deterministic across processes and Deno.readDir's unspecified iteration
 * order, which matters for `manifestDigest` stability.
 */
async function listJsFiles(
  directory: URL,
  excluded: Set<string> = new Set(),
): Promise<string[]> {
  const names: string[] = [];
  for await (const entry of Deno.readDir(directory)) {
    if (entry.isFile && entry.name.endsWith(".js") && !excluded.has(entry.name)) {
      names.push(entry.name);
    }
  }
  return names.sort();
}

/** Sorted list of `*.css` filenames directly inside `public/`. */
async function listCssFiles(): Promise<string[]> {
  const names: string[] = [];
  for await (const entry of Deno.readDir(publicDirectory)) {
    if (entry.isFile && entry.name.endsWith(".css")) {
      names.push(entry.name);
    }
  }
  return names.sort();
}

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

async function fileSpecs(): Promise<FileSpec[]> {
  const specs: FileSpec[] = [];
  const clientNames = await listJsFiles(clientDirectory, EXCLUDED_CLIENT_FILES);
  for (const name of clientNames) {
    specs.push({
      kind: "client",
      logicalPath: `/${name}`,
      contentType: JS_CONTENT_TYPE,
      sourceUrl: clientFile(name),
    });
  }
  const sharedNames = await listJsFiles(sharedDirectory);
  for (const name of sharedNames) {
    specs.push({
      kind: "shared",
      logicalPath: `/shared/${name}`,
      contentType: JS_CONTENT_TYPE,
      sourceUrl: sharedFile(name),
    });
  }
  const cssNames = await listCssFiles();
  for (const name of cssNames) {
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
  const specs = await fileSpecs();
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
