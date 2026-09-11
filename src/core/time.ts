import { TIMESTAMP_PATTERN } from "../schema/defs.js";

/**
 * True when the value is a valid UTC timestamp with an explicit `Z` suffix.
 *
 * Pattern matching alone accepts impossible dates such as `2026-02-30`. This
 * check also verifies the calendar components, so overflow dates fail.
 */
export function isUtcTimestamp(value: string): boolean {
  if (!new RegExp(TIMESTAMP_PATTERN).test(value)) {
    return false;
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return false;
  }
  return (
    date.getUTCFullYear() === Number(value.slice(0, 4)) &&
    date.getUTCMonth() === Number(value.slice(5, 7)) - 1 &&
    date.getUTCDate() === Number(value.slice(8, 10)) &&
    date.getUTCHours() === Number(value.slice(11, 13)) &&
    date.getUTCMinutes() === Number(value.slice(14, 16)) &&
    date.getUTCSeconds() === Number(value.slice(17, 19))
  );
}

/** Current UTC time in the Portable wire format. */
export function nowUtcTimestamp(): string {
  return new Date().toISOString();
}
