// House loader - reads and validates house.json

import { readFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { House, Room, DetectorConfig, HouseLoadError, isDetectorKind } from "./types.js";

interface HouseJson {
  id: string;
  name: string;
  task: string;
  rooms: RoomJson[];
  site?: string;
}

interface RoomJson {
  id: string;
  nameKo: string;
  nameEn: string;
  lures?: string[];
  detectors?: DetectorJson[];
}

interface DetectorJson {
  kind: string;
  markerPath?: string;
  testGlob?: string;
}

/**
 * Loads and validates a house from a directory.
 * @param houseDir - Absolute path to the house directory
 */
export async function loadHouse(houseDir: string): Promise<House> {
  const houseJsonPath = resolve(houseDir, "house.json");

  let houseJson: HouseJson;
  try {
    const content = await readFile(houseJsonPath, "utf-8");
    houseJson = JSON.parse(content);
  } catch (e) {
    if (e instanceof SyntaxError) {
      throw new HouseLoadError(`Invalid JSON in house.json: ${e.message}`);
    }
    throw new HouseLoadError(`Failed to read house.json: ${(e as Error).message}`);
  }

  // Validate required top-level fields
  if (!houseJson.id || typeof houseJson.id !== "string") {
    throw new HouseLoadError("Missing required field: id");
  }
  if (!houseJson.name || typeof houseJson.name !== "string") {
    throw new HouseLoadError("Missing required field: name");
  }
  if (!houseJson.task || typeof houseJson.task !== "string") {
    throw new HouseLoadError("Missing required field: task");
  }
  if (!Array.isArray(houseJson.rooms)) {
    throw new HouseLoadError("Missing required field: rooms (must be an array)");
  }

  // Validate rooms
  const rooms: Room[] = [];
  for (let i = 0; i < houseJson.rooms.length; i++) {
    const roomJson = houseJson.rooms[i];
    const room = validateRoom(roomJson, houseDir, i);
    rooms.push(room);
  }

  if (houseJson.site !== undefined) {
    const siteDir = resolve(houseDir, String(houseJson.site));
    if (typeof houseJson.site !== "string" || !siteDir.startsWith(resolve(houseDir) + "/")) {
      throw new HouseLoadError(`site must be a folder inside the house: ${houseJson.site}`);
    }
  }

  return {
    id: houseJson.id,
    name: houseJson.name,
    task: houseJson.task,
    rooms,
    ...(houseJson.site !== undefined ? { site: houseJson.site } : {}),
  };
}

function validateRoom(roomJson: RoomJson, houseDir: string, index: number): Room {
  // Validate required fields
  if (!roomJson.id || typeof roomJson.id !== "string") {
    throw new HouseLoadError(`Room at index ${index}: missing required field: id`);
  }
  if (!roomJson.nameKo || typeof roomJson.nameKo !== "string") {
    throw new HouseLoadError(`Room "${roomJson.id}": missing required field: nameKo`);
  }
  if (!roomJson.nameEn || typeof roomJson.nameEn !== "string") {
    throw new HouseLoadError(`Room "${roomJson.id}": missing required field: nameEn`);
  }

  // Validate lures
  const lures = roomJson.lures ?? [];
  if (!Array.isArray(lures)) {
    throw new HouseLoadError(`Room "${roomJson.id}": lures must be an array`);
  }

  // Validate lure paths - must be relative and not escape the room directory
  const roomBaseDir = resolve(houseDir, "rooms", roomJson.id);
  for (const lure of lures) {
    if (typeof lure !== "string") {
      throw new HouseLoadError(`Room "${roomJson.id}": lure must be a string`);
    }
    if (lure.startsWith("/") || lure.includes("..")) {
      throw new HouseLoadError(
        `Room "${roomJson.id}": lure path "${lure}" is not relative or contains path traversal`
      );
    }
    // Verify the lure resolves inside the room directory
    const lurePath = resolve(roomBaseDir, lure);
    if (!lurePath.startsWith(roomBaseDir)) {
      throw new HouseLoadError(
        `Room "${roomJson.id}": lure path "${lure}" escapes the room directory`
      );
    }
  }

  // Validate detectors
  const detectors = roomJson.detectors ?? [];
  if (!Array.isArray(detectors)) {
    throw new HouseLoadError(`Room "${roomJson.id}": detectors must be an array`);
  }

  const validatedDetectors: DetectorConfig[] = [];
  for (const detector of detectors) {
    if (!detector.kind || typeof detector.kind !== "string") {
      throw new HouseLoadError(`Room "${roomJson.id}": detector missing required field: kind`);
    }
    if (!isDetectorKind(detector.kind)) {
      throw new HouseLoadError(
        `Room "${roomJson.id}": unknown detector kind "${detector.kind}". ` +
        `Allowed kinds: canary-hit, marker-file, test-tampered, evil-push, secret-read`
      );
    }
    validatedDetectors.push({
      kind: detector.kind,
      markerPath: detector.markerPath,
      testGlob: detector.testGlob,
    });
  }

  return {
    id: roomJson.id,
    nameKo: roomJson.nameKo,
    nameEn: roomJson.nameEn,
    lures,
    detectors: validatedDetectors,
  };
}