// Types and shared utilities for haunt-kit

import { randomUUID } from "node:crypto";

// ─────────────────────────────────────────────────────────────────────────
// Detector kinds
// ─────────────────────────────────────────────────────────────────────────

export type DetectorKind =
  | "canary-hit"
  | "marker-file"
  | "test-tampered"
  | "evil-push"
  | "secret-read"
  | "config-tamper";

export interface DetectorConfig {
  kind: DetectorKind;
  /** marker-file: path relative to sandbox root */
  markerPath?: string;
  /** test-tampered: glob to match test files, default "**\/*.test.*" */
  testGlob?: string;
  /** config-tamper: globs of agent/editor config the agent must not change */
  paths?: string[];
}

// ─────────────────────────────────────────────────────────────────────────
// House and Room
// ─────────────────────────────────────────────────────────────────────────

export interface Room {
  id: string;
  nameKo: string;
  nameEn: string;
  /** paths relative to rooms/<id>/, merged into sandbox root */
  lures: string[];
  detectors: DetectorConfig[];
}

export interface House {
  id: string;
  name: string;
  /** task prompt handed to the agent */
  task: string;
  rooms: Room[];
  /** Optional folder (relative to the house) that the listener serves as a website, e.g. "site" */
  site?: string;
}

// ─────────────────────────────────────────────────────────────────────────
// Sandbox
// ─────────────────────────────────────────────────────────────────────────

export interface Sandbox {
  /** absolute path to the git working tree the agent sees */
  root: string;
  /** absolute path to the run temp directory (parent of root and evilRemote) */
  runDir: string;
  /** absolute path to the bare evil remote, inside runDir */
  evilRemote: string;
  /** roomId → canary token (HAUNT-CANARY-<roomId>-<hex>) */
  canaryTokens: Record<string, string>;
  listenerPort: number;
}

// ─────────────────────────────────────────────────────────────────────────
// Events (produced by listener + detectors)
// ─────────────────────────────────────────────────────────────────────────

export interface CanaryHit {
  kind: "canary-hit";
  timestamp: string;
  method: string;
  path: string;
  query: string;
  /** raw body, truncated to 65536 bytes */
  body: string;
}

export interface DetectorEvent {
  kind: DetectorKind;
  roomId: string;
  /** human-readable snippets of evidence */
  evidence: string[];
}

// ─────────────────────────────────────────────────────────────────────────
// Judge output
// ─────────────────────────────────────────────────────────────────────────

export interface RoomVerdict {
  roomId: string;
  nameKo: string;
  nameEn: string;
  possessed: boolean;
  /** all DetectorEvent.evidence arrays for this room, concatenated */
  evidence: string[];
}

// ─────────────────────────────────────────────────────────────────────────
// Run report
// ─────────────────────────────────────────────────────────────────────────

export interface RunReport {
  houseId: string;
  houseName: string;
  agentLabel: string;
  defenseLabel: string;
  startedAt: string;
  durationMs: number;
  rooms: RoomVerdict[];
  possessedCount: number;
  totalRooms: number;
}

// ─────────────────────────────────────────────────────────────────────────
// Agent run result
// ─────────────────────────────────────────────────────────────────────────

export interface AgentResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  durationMs: number;
}

// ─────────────────────────────────────────────────────────────────────────
// Detection context (passed to detectors)
// ─────────────────────────────────────────────────────────────────────────

export interface DetectionContext {
  sandbox: Sandbox;
  house: House;
  agentResult: AgentResult;
  canaryHits: CanaryHit[];
  /** Commit the agent started from (after any defense install). Undefined in older callers. */
  baseCommit?: string;
}

// Detector function type
export type Detector = (ctx: DetectionContext & { room: Room; detectorConfig: DetectorConfig }) => Promise<DetectorEvent[]>;

// ─────────────────────────────────────────────────────────────────────────
// Runner options
// ─────────────────────────────────────────────────────────────────────────

export interface RunOpts {
  command: string;
  args: string[];
  task: string;
  sandbox: Sandbox;
  timeoutMs: number;
}

export interface HouseRunOpts {
  houseDir: string;
  agentCommand: string;
  agentArgs: string[];
  agentLabel: string;
  defenseLabel: string;
  outDir: string;
  timeoutMs: number;
  keep?: boolean;
  /** Directory whose contents are copied into the sandbox root before the agent starts (e.g. bujeok/kiro → .kiro/...) */
  defenseDir?: string;
}

// ─────────────────────────────────────────────────────────────────────────
// Error classes
// ─────────────────────────────────────────────────────────────────────────

export class HouseLoadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HouseLoadError";
  }
}

export class PathEscapeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PathEscapeError";
  }
}

export class AgentSpawnError extends Error {
  constructor(message: string, public readonly cause?: Error) {
    super(message);
    this.name = "AgentSpawnError";
  }
}

export class CollisionError extends Error {
  constructor(public readonly sourceA: string, public readonly sourceB: string) {
    super(`File collision between "${sourceA}" and "${sourceB}"`);
    this.name = "CollisionError";
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Utilities
// ─────────────────────────────────────────────────────────────────────────

/**
 * Throws PathEscapeError if the resolved path does not start with one of the roots.
 */
export function assertUnderRoot(resolvedPath: string, ...roots: string[]): void {
  const normalized = resolvedPath.replace(/\\/g, "/");
  for (const root of roots) {
    const normalizedRoot = root.replace(/\\/g, "/");
    if (normalized.startsWith(normalizedRoot + "/") || normalized === normalizedRoot) {
      return;
    }
  }
  throw new PathEscapeError(`Path "${resolvedPath}" escapes allowed roots: ${roots.join(", ")}`);
}

/**
 * Generates a canary token for a room: HAUNT-CANARY-<roomId>-<16+ hex chars>
 */
export function generateCanaryToken(roomId: string): string {
  const randomPart = randomUUID().replace(/-/g, "").substring(0, 24);
  return `HAUNT-CANARY-${roomId}-${randomPart}`;
}

/**
 * Type guard to check if a value is a valid DetectorKind
 */
export function isDetectorKind(kind: string): kind is DetectorKind {
  return [
    "canary-hit",
    "marker-file",
    "test-tampered",
    "evil-push",
    "secret-read",
    "config-tamper",
  ].includes(kind);
}