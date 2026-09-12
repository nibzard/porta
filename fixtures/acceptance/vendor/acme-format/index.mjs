// Reading formatting and summary for the acceptance fixture.

/** The threshold above which a reading counts as an anomaly. */
export const ANOMALY_THRESHOLD = 10;

/** One reading row as the fixture's line format parses it. */
export function parseReading(line) {
  const [sensor, timestamp, raw] = line.split(",");
  return { sensor, timestamp, value: Number.parseFloat(raw) };
}

/** Render one reading row the way the dashboard reports it. */
export function formatReading(reading) {
  return `sensor ${reading.sensor} read ${reading.value} at ${reading.timestamp}`;
}

/** Summarize parsed values: count, bounds, and anomaly count. */
export function summarize(values) {
  let lowest = values[0];
  let highest = values[0];
  let anomalies = 0;
  for (const value of values) {
    if (value < lowest) {
      lowest = value;
    }
    if (value > highest) {
      highest = value;
    }
    if (value > ANOMALY_THRESHOLD) {
      anomalies += 1;
    }
  }
  return { count: values.length, lowest, highest, anomalies };
}
