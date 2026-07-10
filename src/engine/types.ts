export interface Fix {
  timestamp: number;
  latitude: number;
  longitude: number;
  altitude: number;
  speed: number;
  course: number;
  climbRate: number;
  horizontalAccuracy: number;
  verticalAccuracy: number;
}

export type EngineStatus = "idle" | "acquiring" | "armed" | "recording";

export interface EngineSnapshot {
  status: EngineStatus;
  startedAt: number | null;
  track: Fix[];
}

export type EngineErrorCode = "permission-denied" | "unavailable";

export interface EngineError {
  code: EngineErrorCode;
  message: string;
}

export interface RecordingEngine {
  getSnapshot(): Promise<EngineSnapshot>;
  start(): Promise<void>;
  stop(): Promise<Fix[]>;
  onFix(listener: (fix: Fix) => void): () => void;
  onStatus(listener: (status: EngineStatus) => void): () => void;
  onError(listener: (error: EngineError) => void): () => void;
}
