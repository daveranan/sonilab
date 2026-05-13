import { createLogger, exportBufferedLogs } from "./logger";

const logger = createLogger("frontend:error-hooks");

export interface ErrorHookOptions {
  exportLocalLogs?: () => Promise<void> | void;
}

export function downloadLocalLogExport(fileName = "sonilabs-logs.json"): void {
  if (typeof document === "undefined" || typeof URL === "undefined") {
    return;
  }

  const url = URL.createObjectURL(exportBufferedLogs());
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  anchor.click();
  URL.revokeObjectURL(url);
}

export function installGlobalErrorHooks(options: ErrorHookOptions = {}): () => void {
  if (typeof window === "undefined") {
    return () => undefined;
  }

  const onError = (event: ErrorEvent) => {
    const code = diagnosticCode("SL-FE", event.message, event.filename, event.lineno);
    logger.error("Unhandled frontend error", {
      code,
      message: event.message,
      filename: event.filename,
      line: event.lineno,
      column: event.colno,
      stack: event.error instanceof Error ? event.error.stack : undefined,
    });
  };

  const onUnhandledRejection = (event: PromiseRejectionEvent) => {
    const reason =
      event.reason instanceof Error ? event.reason.message : String(event.reason);
    const code = diagnosticCode("SL-FE", reason);
    logger.error("Unhandled promise rejection", {
      code,
      reason: event.reason instanceof Error ? event.reason.message : event.reason,
      stack: event.reason instanceof Error ? event.reason.stack : undefined,
    });
  };

  const onBeforeUnload = () => {
    void options.exportLocalLogs?.();
  };

  window.addEventListener("error", onError);
  window.addEventListener("unhandledrejection", onUnhandledRejection);
  window.addEventListener("beforeunload", onBeforeUnload);

  return () => {
    window.removeEventListener("error", onError);
    window.removeEventListener("unhandledrejection", onUnhandledRejection);
    window.removeEventListener("beforeunload", onBeforeUnload);
  };
}

function diagnosticCode(prefix: string, ...parts: unknown[]): string {
  const text = parts.map((part) => String(part ?? "")).join("|");
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return `${prefix}-${(hash >>> 0).toString(16).toUpperCase().padStart(8, "0")}`;
}
