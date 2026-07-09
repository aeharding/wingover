import { MockRecordingEngine } from "./mock";
import type { RecordingEngine } from "./types";

export const engine: RecordingEngine = new MockRecordingEngine();
