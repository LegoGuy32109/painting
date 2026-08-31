export type BrushSize = 1 | 2 | 3 | 4;
export type OpacityPercent = 25 | 50 | 75 | 100;

export interface Cell {
  x: number;
  y: number;
}

export interface BrushBounds {
  minX: number;
  minY: number;
  size: number;
}

export interface PixelChange {
  index: number;
  previous: number;
  color: number;
}

export interface Stroke {
  id: string;
  pointerId: number;
  seen: Set<number>;
  snapshot: Int32Array;
  lastAnchor: Cell | null;
  changed: boolean;
  pendingCells: Array<[index: number, color: number]>;
  progressScheduled: boolean;
  sequence: number;
  paintedCellCount: number;
  brushSize: BrushSize;
  color: number;
  opacity: OpacityPercent;
}

export interface CanvasDocument {
  type: 0 | 1 | 2 | 3;
  glass: boolean;
  pixels: Int32Array;
  id: string;
  version: number;
  title: string | null;
  author: string | null;
  generation: number;
}

export interface PaintProgressDetail {
  canvasId: string;
  strokeId: string;
  sequence: number;
  cells: Array<[index: number, color: number]>;
}

export interface StrokeCommittedDetail {
  canvasId: string;
  strokeId: string;
  sequence: number;
  cellCount: number;
}

export interface UndoAvailabilityDetail {
  canUndo: boolean;
}

export interface UndoCommittedDetail {
  canvasId: string;
  revertsId: string;
}

export interface ColorPickedDetail {
  color: string;
}

export interface PaletteSelection {
  source: "base" | "custom" | "picked" | null;
  index: number | null;
  color: string | null;
}

export interface PaletteWell {
  totalRed: number;
  totalGreen: number;
  totalBlue: number;
  totalMaximum: number;
  numberOfColors: number;
}

export interface PaletteState {
  baseAvailable: boolean[];
  customWells: PaletteWell[];
}

export interface PaletteStateChangedDetail {
  palette: PaletteState;
  selection: PaletteSelection;
}

export type LocalEventKind = "stroke" | "undo";
export type LocalEventStatus = "pending" | "synced";

export interface CanvasSnapshotRecord {
  canvasId: string;
  pixels: Uint8Array;
  baseSequence: number;
  updatedAt: number;
}

export interface LocalEventRecord {
  localKey?: number;
  id: string;
  canvasId: string;
  kind: LocalEventKind;
  strokeId: string | null;
  cells: Uint8Array | null;
  revertsId: string | null;
  clientTs: number;
  status: LocalEventStatus;
}

export interface CanvasLocalRecord {
  id: string;
  title: string | null;
  completedAt: number | null;
  pixels: Uint8Array;
  createdAt: number;
  /** The owner profile's current handle — see PublicCanvas.author. Optional here only because records cached before Phase 3.5 predate the field. */
  author?: string | null;
}

export interface CanvasHistoryRecord {
  canvasId: string;
  sequence: number;
  id: string;
  kind: LocalEventKind;
  strokeId: string | null;
  cells: Uint8Array | null;
  revertsId: string | null;
  clientTs: number;
  receivedAt: number;
}

export interface PushEventPayload {
  id: string;
  kind: "stroke" | "undo";
  strokeId: string | null;
  cells: string | null;
  revertsId: string | null;
  clientTs: number;
}

export interface PushEventsRequest {
  events: PushEventPayload[];
  heartbeatActive: boolean;
}

export interface EventAcknowledgment {
  id: string;
  sequence: number;
}

export interface PushEventsResponse {
  ok: true;
  acknowledgments: EventAcknowledgment[];
  headSequence: number;
}

export interface CompleteCanvasRequest {
  title: string;
}

export interface EnsureDraftRequest {
  id: string;
}

export interface PublicCanvas {
  id: string;
  title: string | null;
  pixels: string;
  createdAt: number;
  lastStrokeAt: number | null;
  completedAt: number | null;
  /** The owner profile's CURRENT handle, joined at read time — null if the owner has no profile row. Reflects a later handle rename immediately. */
  author: string | null;
}

/**
 * One passkey as shown in the /collection account panel. Deliberately
 * excludes anything that would identify the profile or authenticator
 * beyond what's needed to label and delete it — no public key, no
 * counter, no profile id.
 */
export interface CredentialSummary {
  credentialId: string;
  createdAt: number;
  nickname: string | null;
  /** The WebAuthn BS flag: true when synced to a platform password manager (iCloud Keychain, Google Password Manager, ...). */
  backedUp: boolean;
}

export interface ProfileSummaryResponse {
  handle: string | null;
  isAccount: boolean;
  credentialCount: number;
  credentials: CredentialSummary[];
}

/**
 * `PublicKeyCredentialCreationOptionsJSON` and `RegistrationResponseJSON`
 * below are ambient globals from TypeScript's own `dom` lib (WebAuthn L3),
 * not defined here — these are just this app's request/response envelopes
 * around them.
 */
export interface RegisterOptionsResponse {
  options: PublicKeyCredentialCreationOptionsJSON;
}

export interface RegisterVerifyRequest {
  credential: RegistrationResponseJSON;
}

export interface RegisterVerifyResponse {
  ok: true;
  handle: string;
  /** The WebAuthn BS flag for the credential just registered — see CredentialSummary.backedUp. */
  backedUp: boolean;
}

/**
 * `PublicKeyCredentialRequestOptionsJSON` is an ambient WebAuthn L3 global,
 * same as PublicKeyCredentialCreationOptionsJSON above. Deliberately no
 * `allowCredentials` on the wire here — see main.ts's
 * POST /api/auth/login/options: sign-in relies entirely on discoverable
 * credentials, since this product has no username to look credentials up
 * by.
 */
export interface LoginOptionsResponse {
  options: PublicKeyCredentialRequestOptionsJSON;
}

export interface LoginVerifyRequest {
  credential: AuthenticationResponseJSON;
}

/**
 * One draft's summary as shown in the Phase 4 merge dialog — enough to
 * render a thumbnail and let a user tell the two paintings apart, nothing
 * more. `strokeCount` counts only 'stroke' events (an undo doesn't add a
 * stroke to the painting, so it's excluded); `lastActivityAt` is
 * `lastStrokeAt ?? createdAt`, for the dialog's "last touched" copy.
 */
export interface DraftMergeSummary {
  id: string;
  pixels: string;
  strokeCount: number;
  lastActivityAt: number;
}

/**
 * The four-case merge table (see docs and main.ts) collapses to two
 * response shapes: three rows are silent (the account session cookie is
 * already set in the same response) and the fourth needs a user decision,
 * carrying a mergeToken and both drafts' summaries instead of setting any
 * cookie at all — see POST /api/auth/merge.
 */
export interface LoginVerifySilentResponse {
  ok: true;
  handle: string;
  merge: { pending: false };
}

export interface LoginVerifyPendingResponse {
  ok: true;
  merge: {
    pending: true;
    mergeToken: string;
    deviceDraft: DraftMergeSummary;
    accountDraft: DraftMergeSummary;
  };
}

export type LoginVerifyResponse =
  | LoginVerifySilentResponse
  | LoginVerifyPendingResponse;

export interface MergeRequest {
  mergeToken: string;
  keep: "device" | "account";
}

export interface MergeResponse {
  ok: true;
  handle: string;
}

export interface LogoutResponse {
  ok: true;
}

// --- Phase 5: transfer codes ------------------------------------------

/**
 * See docs/transfer-codes.md. `code` is the canonical, unformatted
 * 8-character form (src/shared/transfer-code.js's TRANSFER_CODE_ALPHABET) —
 * display grouping (formatTransferCodeForDisplay()) is a client-only
 * presentation detail, not part of the wire format.
 */
export interface TransferGenerateResponse {
  ok: true;
  code: string;
  expiresAt: number;
}

export interface TransferConsumeRequest {
  code: string;
}

/**
 * Deliberately the SAME shape login/verify returns (LoginVerifyResponse)
 * — consuming a transfer code lands in exactly the same four-case merge
 * situation as signing in with a passkey, resolved by the same shared
 * server-side path (see main.ts's resolveSignInMerge()) and the same
 * client-side merge dialog. There is no separate "transfer verify"
 * response shape to keep in sync with it.
 */
export type TransferConsumeResponse = LoginVerifyResponse;

export interface RenameHandleRequest {
  handle: string;
}

export interface RenameHandleResponse {
  ok: true;
  handle: string;
}

export interface GuestCanvasesResponse {
  draft: PublicCanvas | null;
  completed: PublicCanvas[];
}

export interface EnsureDraftResponse {
  draft: PublicCanvas;
  acceptedPreferredId: boolean;
}

export interface DisplayFeedResponse {
  active: PublicCanvas[];
  completed: PublicCanvas[];
}

export interface CompletedFeedResponse {
  paintings: PublicCanvas[];
  nextCursor: string | null;
}

export interface LiveSyncMessage {
  version: 1;
  type: "sync";
  canvases: Array<{ canvas: PublicCanvas; headSequence: number }>;
}

export interface LiveSnapshotMessage {
  version: 1;
  type: "snapshot";
  canvas: PublicCanvas;
  headSequence: number;
}

export interface LiveDiffMessage {
  version: 1;
  type: "diff";
  canvasId: string;
  headSequence: number;
  batches: Array<
    { sequence: number; ts: number; cells: Array<[number, number]> }
  >;
}

export interface LiveCompletedMessage {
  version: 1;
  type: "completed";
  canvas: PublicCanvas;
  headSequence: number;
}

export interface LiveInactiveMessage {
  version: 1;
  type: "inactive";
  canvasId: string;
  reason: "idle" | "completed" | "missing";
}

export type LiveStreamMessage =
  | LiveSyncMessage
  | LiveSnapshotMessage
  | LiveDiffMessage
  | LiveCompletedMessage
  | LiveInactiveMessage;

export interface ReplayDiffStep {
  type: "diff";
  atMs: number;
  cells: string;
}

export interface ReplaySnapshotStep {
  type: "snapshot";
  atMs: number;
  pixels: string;
}

export type ReplayStep = ReplayDiffStep | ReplaySnapshotStep;

export interface CanvasReplayResponse {
  id: string;
  title: string;
  /** The owner profile's current handle (see PublicCanvas.author) — null if the owner has no profile row. */
  author: string | null;
  initialPixels: string;
  finalPixels: string;
  durationMs: number;
  steps: ReplayStep[];
}

export type SyncStatusKind =
  | "restoring"
  | "local"
  | "syncing"
  | "synced"
  | "offline"
  | "retrying"
  | "blocked"
  | "signed";

export interface SyncStatus {
  kind: SyncStatusKind;
  message: string;
}

/**
 * One event exactly as stored, wire-shaped the same way PushEventPayload
 * is (cells base64-encoded), plus the server-assigned `sequence` — a
 * .jpaint export always includes the FULL, unbounded event log for the
 * canvas (see docs/jpaint-format.md), never the bounded/clamped-timeline
 * "steps" CanvasReplayResponse uses for the live ambient display.
 */
export interface JpaintEvent {
  sequence: number;
  id: string;
  kind: "stroke" | "undo";
  strokeId: string | null;
  cells: string | null;
  revertsId: string | null;
  clientTs: number;
}

/**
 * The .jpaint export document for one signed painting — see
 * docs/jpaint-format.md for the full format description and its mapping
 * (where one exists) to the original mod's `.paint` NBT fields.
 *
 * `jpaint` is the format version and MUST be the first key (this is
 * enforced by construction in buildJpaintDocument(), not by this type —
 * TypeScript object types have no field-order guarantee, but
 * JSON.stringify preserves the insertion order of a real object literal).
 */
export interface JpaintDocument {
  jpaint: 1;
  id: string;
  title: string | null;
  author: string | null;
  width: number;
  height: number;
  createdAt: number;
  completedAt: number | null;
  /** The authoritative final render — base64 of the Int32Array pixel buffer, same encoding PublicCanvas.pixels uses. */
  pixels: string;
  /** The complete, unbounded event log for this canvas, in sequence order — see JpaintEvent. */
  events: JpaintEvent[];
}
