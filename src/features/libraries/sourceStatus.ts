import { AlertCircle, CheckCircle2, CirclePause, Loader2, WifiOff } from "lucide-react";

export type SourceStatus = "connected" | "indexing" | "paused" | "offline" | "error";

export const sourceStatusLabels: Record<SourceStatus, string> = {
  connected: "Connected",
  indexing: "Indexing",
  paused: "Paused",
  offline: "Offline",
  error: "Error",
};

export const sourceStatusIcon = {
  connected: CheckCircle2,
  indexing: Loader2,
  paused: CirclePause,
  offline: WifiOff,
  error: AlertCircle,
};
