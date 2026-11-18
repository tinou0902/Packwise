let logger: ((line: string) => void) | undefined;

/** Receives every command line and the output of commands that change something (add/remove). */
export function setLogger(fn: (line: string) => void): void {
  logger = fn;
}

export function log(line: string): void {
  logger?.(line);
}
