import { useSyncExternalStore } from 'react';

export interface ActivityEntry {
  id: number;
  timestamp: number;
  command: string;
  args: string;
  stdin?: string;
  status: 'running' | 'success' | 'error';
  durationMs?: number;
  error?: string;
}

const MAX_ENTRIES = 2000;
// Per-field bound so a huge payload (e.g. a resolved file) can't bloat 2000 entries.
const MAX_FIELD = 64 * 1024;
// Total in-memory budget (summed field lengths) across all entries, in addition to MAX_ENTRIES.
const MAX_TOTAL_CHARS = 4 * 1024 * 1024;
const REDACT_KEY_REGEX = /token|password|secret|credential/i;

// Routine reads, polling and UI plumbing: omitted on success so the log stays an
// operations log, but still recorded if they fail.
const QUIET_COMMANDS = new Set([
  'app_start_dragging',
  'list_provider_accounts',
  'provider_oauth_poll',
  'provider_pull_requests',
  'repository_operation_state',
  'repository_snapshot',
  'repository_status',
  'repository_state',
  'repository_history',
  'repository_commit',
  'repository_diff',
  'repository_diff_files',
  'repository_search',
  'repository_recent',
  'repository_remotes',
  'repository_sync_info',
  'repository_stashes',
  'repository_git_identity',
  'repository_branch_relation',
  'repository_conflict_file',
  'repository_pick',
  'repository_pick_clone_parent',
  'wsl_distributions',
  'wsl_directories',
]);

// Anchored on the literal `://` so scanning stays linear on long strings (a leading scheme pattern backtracks quadratically).
const URL_USERINFO = /:\/\/[^\s/?#]*@/g;
/** Strips credentials from URLs: userinfo anywhere in text, and query/fragment of whole-URL values. */
export function scrubUrls(text: string, wholeValue = false): string {
  const scrubbed = text.replace(URL_USERINFO, '://[redacted]@');
  return wholeValue && /^[a-z][a-z0-9+.-]*:\/\//i.test(scrubbed) ? scrubbed.replace(/[?#][\s\S]*$/, '?[redacted]') : scrubbed;
}

const utf8Bytes = (text: string): number => new TextEncoder().encode(text).length;

function redactValue(key: string, value: unknown): unknown {
  if (REDACT_KEY_REGEX.test(key)) {
    return '[redacted]';
  }
  // Defence in depth: file/resolution text is never retained, only its size.
  if (key === 'content') {
    return typeof value === 'string' ? { bytes: utf8Bytes(value) } : '[content omitted]';
  }
  if (typeof value === 'string') return scrubUrls(value, true);
  if (value && typeof value === 'object') {
    if (Array.isArray(value)) {
      return value.map((item, index) => redactValue(String(index), item));
    }
    const sanitized: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      sanitized[k] = redactValue(k, v);
    }
    return sanitized;
  }
  return value;
}

function clip(text: string): string {
  return text.length > MAX_FIELD ? `${text.slice(0, MAX_FIELD)}\n… [${text.length - MAX_FIELD} more characters not kept]` : text;
}

type ArgsSummarizer = (args: Record<string, unknown>) => Record<string, unknown>;

// Commands whose arguments carry bulk or sensitive payloads get an explicit allowlist summary.
const COMMAND_SUMMARIZERS: Record<string, ArgsSummarizer> = {
  repository_resolve_conflict: args => {
    const resolution = args.resolution && typeof args.resolution === 'object' ? args.resolution as Record<string, unknown> : undefined;
    const summary: Record<string, unknown> = {};
    if ('handle' in args) summary.handle = args.handle;
    summary.path = args.path;
    summary.fingerprint = args.fingerprint;
    if (resolution) {
      summary.resolution = {
        kind: resolution.kind,
        ...(typeof resolution.content === 'string' ? { contentBytes: utf8Bytes(resolution.content) } : {}),
      };
    }
    return summary;
  },
};

export function summarizeArgs(command: string, args: Record<string, unknown> = {}): string {
  try {
    const source = COMMAND_SUMMARIZERS[command]?.(args) ?? args;
    const sanitized: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(source)) {
      sanitized[k] = redactValue(k, v);
    }
    const str = JSON.stringify(sanitized);
    if (!str || str === '{}') return '';
    return clip(str);
  } catch {
    return '[unserializable]';
  }
}

let nextId = 1;
let entries: ActivityEntry[] = [];
const listeners = new Set<() => void>();

function notify() {
  for (const listener of listeners) {
    listener();
  }
}

// Quiet calls are held here until they finish; only failures reach `entries`.
const pendingQuiet = new Map<number, { command: string; timestamp: number; args: Record<string, unknown> }>();

const entrySize = (e: ActivityEntry) => e.command.length + e.args.length + (e.stdin?.length ?? 0) + (e.error?.length ?? 0);

/** Drops oldest entries until the total size fits the budget (always keeps the newest entry). */
function enforceBudget() {
  let total = entries.reduce((n, e) => n + entrySize(e), 0);
  let drop = 0;
  while (total > MAX_TOTAL_CHARS && drop < entries.length - 1) total -= entrySize(entries[drop++]);
  if (drop) entries = entries.slice(drop);
}

function append(entry: ActivityEntry) {
  entries = [...entries, entry].slice(-MAX_ENTRIES);
  enforceBudget();
  notify();
}

export function recordCommandStart(command: string, rawArgs: Record<string, unknown> = {}): number {
  const id = nextId++;
  if (QUIET_COMMANDS.has(command)) {
    pendingQuiet.set(id, { command, timestamp: Date.now(), args: rawArgs });
    return id;
  }
  append({ id, timestamp: Date.now(), command, args: summarizeArgs(command, rawArgs), status: 'running' });
  return id;
}

export function recordCommandEnd(id: number, status: 'success' | 'error', durationMs: number, error?: string): void {
  const safeError = error === undefined ? undefined : clip(scrubUrls(error));
  const quiet = pendingQuiet.get(id);
  if (quiet) {
    pendingQuiet.delete(id);
    if (status === 'error') {
      append({ id, timestamp: quiet.timestamp, command: quiet.command, args: summarizeArgs(quiet.command, quiet.args), status, durationMs: Math.round(durationMs), ...(safeError ? { error: safeError } : {}) });
    }
    return;
  }
  const index = entries.findIndex(e => e.id === id);
  if (index === -1) return;
  const updated: ActivityEntry = { ...entries[index], status, durationMs: Math.round(durationMs), ...(safeError ? { error: safeError } : {}) };
  entries = [...entries.slice(0, index), updated, ...entries.slice(index + 1)];
  enforceBudget();
  notify();
}

/** A Git write the backend ran, reported after it finished (`git_command` event). */
export interface GitCommandEvent { command: string; stdin: string | null; success: boolean; code: number | null; millis: number }
export function recordGitCommand({ command, stdin, success, code, millis }: GitCommandEvent): void {
  append({
    id: nextId++,
    timestamp: Date.now() - millis,
    command: scrubUrls(command),
    args: '',
    ...(stdin ? { stdin: clip(scrubUrls(stdin)) } : {}),
    status: success ? 'success' : 'error',
    durationMs: millis,
    ...(success ? {} : { error: code === null ? 'Git did not run to completion' : `Git exited with code ${code}` }),
  });
}

export function clearActivityLog(): void {
  entries = [];
  notify();
}

export function getActivityLog(): ActivityEntry[] {
  return entries;
}

function subscribe(callback: () => void): () => void {
  listeners.add(callback);
  return () => {
    listeners.delete(callback);
  };
}

export function useActivityLog(): ActivityEntry[] {
  return useSyncExternalStore(subscribe, getActivityLog);
}
