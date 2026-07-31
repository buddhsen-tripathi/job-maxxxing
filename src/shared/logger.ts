export type LogFields = Record<string, unknown> & { operation: string };

export interface Logger {
  info(fields: LogFields): void;
  warn(fields: LogFields): void;
  error(fields: LogFields): void;
  child(base: Record<string, unknown>): Logger;
}

export function createLogger(base: Record<string, unknown> = {}): Logger {
  const write = (level: "info" | "warn" | "error", fields: LogFields) => {
    const line = JSON.stringify({ level, ts: new Date().toISOString(), ...base, ...fields });
    if (level === "error") {
      console.error(line);
    } else {
      console.log(line);
    }
  };
  return {
    info: (fields) => write("info", fields),
    warn: (fields) => write("warn", fields),
    error: (fields) => write("error", fields),
    child: (extra) => createLogger({ ...base, ...extra }),
  };
}

export const noopLogger: Logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => noopLogger,
};
