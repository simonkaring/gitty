import { useEffect, useRef, useState } from 'react';
import { Copy, Trash2, Search, Check } from 'lucide-react';
import { Dialog } from './ui';
import { clearActivityLog, useActivityLog, type ActivityEntry } from '../model/activity';

function formatTimestamp(ts: number): string {
  const d = new Date(ts);
  const h = String(d.getHours()).padStart(2, '0');
  const m = String(d.getMinutes()).padStart(2, '0');
  const s = String(d.getSeconds()).padStart(2, '0');
  const ms = String(d.getMilliseconds()).padStart(3, '0');
  return `${h}:${m}:${s}.${ms}`;
}

function formatDuration(ms?: number): string {
  if (ms === undefined) return '';
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

/** The labelled text blocks under an entry's command line, shown in full. */
function details(entry: ActivityEntry): [label: string, text: string][] {
  return [
    ...(entry.stdin ? [['stdin', entry.stdin] as [string, string]] : []),
    ...(entry.args ? [['args', entry.args] as [string, string]] : []),
    ...(entry.error ? [['error', entry.error] as [string, string]] : []),
  ];
}

function entryText(entry: ActivityEntry): string {
  const head = `[${formatTimestamp(entry.timestamp)}] ${entry.status.toUpperCase()} ${entry.command}${entry.durationMs === undefined ? '' : ` (${formatDuration(entry.durationMs)})`}`;
  return [head, ...details(entry).map(([label, text]) => `  ${label}: ${text.replace(/\n/g, '\n    ')}`)].join('\n');
}

export function ActivityLogDialog({ onClose }: { onClose: () => void }) {
  const entries = useActivityLog();
  const [filter, setFilter] = useState('');
  const [copied, setCopied] = useState(false);
  const consoleRef = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);

  const term = filter.toLowerCase();
  const shown = term
    ? entries.filter(entry => [entry.command, entry.status, entry.args, entry.stdin, entry.error].some(text => text?.toLowerCase().includes(term)))
    : entries;

  // Like a terminal: oldest first, following new output unless the user scrolled up.
  useEffect(() => {
    const el = consoleRef.current;
    if (el && pinned.current) el.scrollTop = el.scrollHeight;
  }, [shown]);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(entries.map(entryText).join('\n'));
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // ignore clipboard error
    }
  };

  const footer = (
    <>
      <button type="button" className="secondary-button" onClick={clearActivityLog} disabled={entries.length === 0}>
        <Trash2 size={14} /> Clear
      </button>
      <button type="button" className="secondary-button" onClick={handleCopy} disabled={entries.length === 0}>
        {copied ? <Check size={14} /> : <Copy size={14} />} {copied ? 'Copied' : 'Copy'}
      </button>
      <button type="button" className="primary-button" onClick={onClose}>Done</button>
    </>
  );

  return (
    <Dialog title="Activity log" onClose={onClose} size="lg" className="activity-log-dialog" footer={footer}>
      <div className="activity-toolbar">
        <div className="search-input-wrapper">
          <Search size={14} className="search-icon" />
          <input
            type="search"
            placeholder="Filter commands, paths, messages…"
            value={filter}
            onChange={e => setFilter(e.target.value)}
            aria-label="Filter activity log"
            autoFocus
          />
        </div>
        <span className="activity-count">
          {shown.length} of {entries.length} {entries.length === 1 ? 'event' : 'events'}
        </span>
      </div>

      <div
        className="console"
        ref={consoleRef}
        role="log"
        aria-label="Activity output"
        tabIndex={0}
        onScroll={e => { const el = e.currentTarget; pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24; }}
      >
        {shown.length === 0
          ? <div className="console-empty">{entries.length === 0 ? 'No activity recorded yet.' : 'No output matches the filter.'}</div>
          : shown.map(entry => <ConsoleEntry key={entry.id} entry={entry} />)}
      </div>
    </Dialog>
  );
}

function ConsoleEntry({ entry }: { entry: ActivityEntry }) {
  return (
    <div className="console-entry" data-status={entry.status}>
      <div className="console-line">
        <span className="console-time">{formatTimestamp(entry.timestamp)}</span>
        <span className="console-prompt" aria-hidden="true">{entry.command.startsWith('git ') ? '$' : '>'}</span>
        <span className="console-command">{entry.command}</span>
        <span className="console-status">{entry.status === 'running' ? 'running…' : `${entry.status === 'success' ? 'ok' : 'failed'} ${formatDuration(entry.durationMs)}`}</span>
      </div>
      {details(entry).map(([label, text]) => (
        <div className="console-row" key={label} data-label={label}>
          <span className="console-label">{label}</span>
          <pre>{text}</pre>
        </div>
      ))}
    </div>
  );
}
