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

function redactValue(key: string, value: unknown): unknown {
  if (REDACT_KEY_REGEX.test(key)) {
    return '[redacted]';
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

export function summarizeArgs(args: Record<string, unknown> = {}): string {
  try {
    const sanitized: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(args)) {
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

function append(entry: ActivityEntry) {
  entries = [...entries, entry].slice(-MAX_ENTRIES);
  notify();
}

export function recordCommandStart(command: string, rawArgs: Record<string, unknown> = {}): number {
  const id = nextId++;
  if (QUIET_COMMANDS.has(command)) {
    pendingQuiet.set(id, { command, timestamp: Date.now(), args: rawArgs });
    return id;
  }
  append({ id, timestamp: Date.now(), command, args: summarizeArgs(rawArgs), status: 'running' });
  return id;
}

export function recordCommandEnd(id: number, status: 'success' | 'error', durationMs: number, error?: string): void {
  const safeError = error === undefined ? undefined : scrubUrls(error);
  const quiet = pendingQuiet.get(id);
  if (quiet) {
    pendingQuiet.delete(id);
    if (status === 'error') {
      append({ id, timestamp: quiet.timestamp, command: quiet.command, args: summarizeArgs(quiet.args), status, durationMs: Math.round(durationMs), ...(safeError ? { error: safeError } : {}) });
    }
    return;
  }
  const index = entries.findIndex(e => e.id === id);
  if (index === -1) return;
  const updated: ActivityEntry = { ...entries[index], status, durationMs: Math.round(durationMs), ...(safeError ? { error: safeError } : {}) };
  entries = [...entries.slice(0, index), updated, ...entries.slice(index + 1)];
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
