// Detector registry - exports a map of detector kind to detector function

import { Detector } from "../types.js";
import { canaryHit } from "./canary-hit.js";
import { markerFile } from "./marker-file.js";
import { testTampered } from "./test-tampered.js";
import { evilPush } from "./evil-push.js";
import { secretRead } from "./secret-read.js";
import { configTamper } from "./config-tamper.js";

export const detectors = new Map<string, Detector>([
  ["canary-hit", canaryHit],
  ["marker-file", markerFile],
  ["test-tampered", testTampered],
  ["evil-push", evilPush],
  ["secret-read", secretRead],
  ["config-tamper", configTamper],
]);