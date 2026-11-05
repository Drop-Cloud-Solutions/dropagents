/**
 * Port: structured logger. Adapters decide on transport (stdout, file,
 * Loki, Application Insights, ...) and formatting. The core only needs
 * the four severity levels.
 */
export interface Logger {
  info(message: string, meta?: Readonly<Record<string, unknown>>): void;
  warn(message: string, meta?: Readonly<Record<string, unknown>>): void;
  error(message: string, meta?: Readonly<Record<string, unknown>>): void;
  debug(message: string, meta?: Readonly<Record<string, unknown>>): void;
}
