import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { CornerDownLeft, Search } from 'lucide-react';

export interface PaletteCommand { id: string; label: string; group: string; hint?: string; icon?: ReactNode; disabled?: boolean; run: () => void }

/** Subsequence match. Returns matched indices (for highlighting) and a score
 * where lower is better: contiguous, early, word-start hits rank first. */
export function fuzzy(label: string, query: string): { score: number; hits: number[] } | null {
  const text = label.toLowerCase(), q = query.toLowerCase().trim();
  if (!q) return { score: 0, hits: [] };
  const direct = text.indexOf(q);
  if (direct >= 0) return { score: direct === 0 || text[direct - 1] === ' ' ? direct / 100 : 1 + direct / 100, hits: Array.from(q, (_, i) => direct + i) };
  const hits: number[] = [];
  let from = 0;
  for (const char of q) {
    const at = text.indexOf(char, from);
    if (at < 0) return null;
    hits.push(at); from = at + 1;
  }
  return { score: 2 + (hits[hits.length - 1] - hits[0]) / 10, hits };
}

function Highlight({ label, hits }: { label: string; hits: number[] }) {
  if (!hits.length) return <>{label}</>;
  const set = new Set(hits);
  return <>{Array.from(label, (char, i) => set.has(i) ? <mark key={i}>{char}</mark> : char)}</>;
}

export function CommandPalette({ commands, onClose }: { commands: PaletteCommand[]; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const [query, setQuery] = useState('');
  const [index, setIndex] = useState(0);
  useEffect(() => { dialog.current?.showModal(); }, []);
  const results = useMemo(() => {
    const scored = commands.flatMap(command => { const match = fuzzy(command.label, query); return match ? [{ command, ...match }] : []; });
    // Without a query keep the authored group order; with one, rank by score.
    return query.trim() ? scored.sort((a, b) => a.score - b.score) : scored;
  }, [commands, query]);
  useEffect(() => setIndex(0), [query]);
  useEffect(() => { list.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' }); }, [index]);
  function run(command: PaletteCommand | undefined) {
    if (!command || command.disabled) return;
    onClose();
    command.run();
  }
  const grouped = !query.trim();
  return <dialog ref={dialog} className="dialog command-palette" aria-label="Command palette" onCancel={event => { event.preventDefault(); onClose(); }}
    onClick={event => { if (event.target === dialog.current) onClose(); }}>
    <div className="palette-search">
      <Search size={16} />
      <input autoFocus role="combobox" aria-expanded="true" aria-controls="palette-results" aria-autocomplete="list" aria-label="Search commands"
        aria-activedescendant={results[index] ? `palette-${results[index].command.id}` : undefined}
        placeholder="Type a command, branch, or theme…" value={query} onChange={event => setQuery(event.target.value)}
        onKeyDown={event => {
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); const step = event.key === 'ArrowDown' ? 1 : -1; setIndex(current => results.length ? (current + step + results.length) % results.length : 0); }
          else if (event.key === 'Enter') { event.preventDefault(); run(results[index]?.command); }
        }} />
      <kbd>esc</kbd>
    </div>
    <div className="palette-results" id="palette-results" role="listbox" aria-label="Commands" ref={list}>
      {results.map(({ command, hits }, i) => <div key={command.id}>
        {grouped && command.group !== results[i - 1]?.command.group && <div className="palette-group" role="presentation">{command.group}</div>}
        <div id={`palette-${command.id}`} role="option" aria-selected={i === index} aria-disabled={command.disabled || undefined} className="palette-item"
          onMouseMove={() => { if (index !== i) setIndex(i); }} onClick={() => run(command)}>
          <span className="palette-icon">{command.icon}</span>
          <span className="palette-label"><Highlight label={command.label} hits={hits} /></span>
          {command.hint && <span className="palette-hint">{command.hint}</span>}
          {i === index && <CornerDownLeft size={14} className="palette-enter" />}
        </div>
      </div>)}
      {!results.length && <p className="palette-empty">No matching commands.</p>}
    </div>
  </dialog>;
}
