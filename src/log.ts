/**
 * Session activity log: what happened to fonts, pages and exports since the tab was opened.
 * In memory only (gone on reload); every entry is also printed to the browser console.
 * In the console, `text2gcode.log()` prints the whole session as a table.
 */
export interface LogEntry {
  time: string;
  action: string;
  detail: string;
}

const entries: LogEntry[] = [];

export function logAction(action: string, detail = "") {
  const entry = { time: new Date().toLocaleTimeString(), action, detail };
  entries.push(entry);
  console.info(`[text2gcode] ${entry.time} ${action}${detail ? `: ${detail}` : ""}`);
}

export const sessionLog = (): readonly LogEntry[] => entries;

declare global {
  /** Console helper: `text2gcode.log()` prints this session's activity. */
  var text2gcode: { log: () => void };
}
globalThis.text2gcode = { log: () => console.table(entries) };
