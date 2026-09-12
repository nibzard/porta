/** Output sinks for the CLI. Tests install recording sinks. */
export interface CliIo {
  out(line: string): void;
  err(line: string): void;
}
