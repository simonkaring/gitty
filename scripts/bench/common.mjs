import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Default working directory for fixtures, probe builds and results. */
export function benchDir() {
  return process.env.GITTY_BENCH_DIR ?? join(tmpdir(), 'gitty-bench');
}

/** `--key value` and bare `--flag` arguments; comma lists stay strings. */
export function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i].replace(/^--/, '');
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) out[key] = true;
    else { out[key] = next; i++; }
  }
  return out;
}

export function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

export function table(headers, rows) {
  const cells = [headers, ...rows].map(row => row.map(cell => cell === null || cell === undefined ? '–' : String(cell)));
  const widths = headers.map((_, i) => Math.max(...cells.map(row => row[i].length)));
  const line = row => `| ${row.map((cell, i) => cell.padEnd(widths[i])).join(' | ')} |`;
  return [line(cells[0]), `| ${widths.map(w => '-'.repeat(w)).join(' | ')} |`, ...cells.slice(1).map(line)].join('\n');
}

export const ms = value => value === null || value === undefined ? null : value >= 1000 ? `${(value / 1000).toFixed(2)} s` : `${value.toFixed(value < 10 ? 1 : 0)} ms`;
export const mb = bytes => bytes === null || bytes === undefined ? null : `${(bytes / 1024 / 1024).toFixed(0)} MB`;
