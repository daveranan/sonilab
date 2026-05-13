export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogEvent {
  level: LogLevel;
  scope: string;
  message: string;
  context?: Record<string, unknown>;
  timestamp: string;
}

export type LogSink = (event: LogEvent) => void;

const sinks = new Set<LogSink>();
const memoryEvents: LogEvent[] = [];
const maxMemoryEvents = 1_000;

const defaultConsoleSink: LogSink = (event) => {
  const method = event.level === "debug" ? "debug" : event.level;
  console[method](`[${event.timestamp}] ${event.scope}: ${event.message}`, {
    ...event.context,
    level: event.level,
  });
};

sinks.add((event) => {
  memoryEvents.push(event);

  if (memoryEvents.length > maxMemoryEvents) {
    memoryEvents.splice(0, memoryEvents.length - maxMemoryEvents);
  }
});

if (typeof console !== "undefined") {
  sinks.add(defaultConsoleSink);
}

export function addLogSink(sink: LogSink): () => void {
  sinks.add(sink);
  return () => sinks.delete(sink);
}

export function getBufferedLogEvents(): LogEvent[] {
  return [...memoryEvents];
}

export function exportBufferedLogs(): Blob {
  return new Blob([`${JSON.stringify(getBufferedLogEvents(), null, 2)}\n`], {
    type: "application/json",
  });
}

export const loggers = {
  frontend: createScopedLogger("frontend"),
  backend: createScopedLogger("backend"),
  jobs: createScopedLogger("job-queue"),
  exportFailures: createScopedLogger("export-failure"),
};

function createScopedLogger(scopePrefix: string) {
  return (scope: string) => createLogger(`${scopePrefix}:${scope}`);
}

export function createLogger(scope: string) {
  const emit = (
    level: LogLevel,
    message: string,
    context?: Record<string, unknown>,
  ) => {
    const event: LogEvent = {
      level,
      scope,
      message,
      context,
      timestamp: new Date().toISOString(),
    };

    for (const sink of sinks) {
      sink(event);
    }
  };

  return {
    debug: (message: string, context?: Record<string, unknown>) =>
      emit("debug", message, context),
    info: (message: string, context?: Record<string, unknown>) =>
      emit("info", message, context),
    warn: (message: string, context?: Record<string, unknown>) =>
      emit("warn", message, context),
    error: (message: string, context?: Record<string, unknown>) =>
      emit("error", message, context),
  };
}
