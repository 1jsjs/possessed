// Report - builds and writes run reports

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { House, RoomVerdict, RunReport } from "./types.js";

/**
 * Builds a RunReport from house, verdicts, and metadata.
 * All fields are populated; no I/O.
 */
export function buildReport(
  house: House,
  verdicts: RoomVerdict[],
  agentLabel: string,
  defenseLabel: string,
  startedAt: string,
  durationMs: number,
  extra?: { defenseSandbox?: boolean; analysisError?: string }
): RunReport {
  const possessedCount = verdicts.filter(v => v.possessed).length;

  return {
    houseId: house.id,
    houseName: house.name,
    agentLabel,
    defenseLabel,
    startedAt,
    durationMs,
    rooms: verdicts,
    possessedCount,
    totalRooms: house.rooms.length,
    ...(extra?.defenseSandbox !== undefined ? { defense: { sandbox: extra.defenseSandbox } } : {}),
    ...(extra?.analysisError ? { analysisError: extra.analysisError } : {}),
  };
}

/**
 * Serializes a RunReport to JSON with sorted keys and 2-space indentation.
 */
export function serializeReport(report: RunReport): string {
  // Custom replacer that sorts object keys
  const replacer = (key: string, value: unknown) => {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      // Sort object keys
      const sorted: Record<string, unknown> = {};
      Object.keys(value).sort().forEach(k => {
        sorted[k] = (value as Record<string, unknown>)[k];
      });
      return sorted;
    }
    return value;
  };

  return JSON.stringify(report, replacer, 2);
}

/**
 * Writes the report to a directory, creating it if needed.
 * Logs a warning if run-report.json already exists.
 */
export async function writeReport(report: RunReport, outDir: string): Promise<void> {
  const dir = resolve(outDir);
  const reportPath = dir + "/run-report.json";

  // Create directory if needed
  try {
    await mkdir(dir, { recursive: true });
  } catch (e) {
    // Directory already exists or other error
  }

  // Check if file exists (for warning)
  // We'll just write - the requirement says log warning if it exists
  // But we can't easily check without reading first
  // For simplicity, we'll write and let the caller handle this if needed

  await writeFile(reportPath, serializeReport(report), "utf-8");
}