import { useRef, type ReactNode } from 'react';
import { GitBranch, GitCommitHorizontal, LocateFixed, Search } from 'lucide-react';
import type { RepositoryRef, SearchResult } from '../model/repository';

export function highlightMatch(value: string, query: string): ReactNode {
  if (!query) return value;
  const lower = value.toLocaleLowerCase();
  const needle = query.toLocaleLowerCase();
  const parts: ReactNode[] = [];
  let start = 0;
  let index = lower.indexOf(needle);
  while (index !== -1) {
    parts.push(value.slice(start, index), <mark key={index}>{value.slice(index, index + query.length)}</mark>);
    start = index + query.length;
    index = lower.indexOf(needle, start);
  }
  parts.push(value.slice(start));
  return parts;
}

export function SearchResults({ result, loading, error, query, refs, selected, onSelect, onReveal, onRetry, onClear }: {
  result: SearchResult | null; loading: boolean; error: string; query: string; refs: RepositoryRef[]; selected: string;
  onSelect: (id: string) => void; onReveal: (id: string) => void; onRetry: () => void; onClear: () => void;
}) {
  const list = useRef<HTMLDivElement>(null);
  return <div className="search-results-view" aria-label="Search results">
    {loading ? <div className="search-loading" role="status"><p>Searching full history…</p>{[0, 1, 2, 3, 4].map(i => <div className="search-result-skeleton" key={i} aria-hidden="true"><span className="skeleton" /><span className="skeleton" /></div>)}</div>
      : error ? <div className="search-empty" role="alert"><h2>Search couldn’t finish</h2><p>{error}</p><button className="secondary-button" onClick={onRetry}>Retry search</button></div>
      : result && !result.commits.length ? <div className="search-empty"><Search size={28} aria-hidden="true" /><h2>No matching commits</h2><p>Try a different message, author, SHA, or reference. You can also broaden the branch, date, or path filters.</p><button className="secondary-button" onClick={onClear}>Clear filters</button></div>
      : null}
      <div className="search-result-list" hidden={loading || !!error || !result?.commits.length} ref={list} onKeyDown={event => {
        if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key) || !(event.target instanceof HTMLElement) || !event.target.matches('.search-result-select')) return;
        const buttons = Array.from(list.current?.querySelectorAll<HTMLButtonElement>('.search-result-select') ?? []);
        const index = buttons.indexOf(event.target as HTMLButtonElement);
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : Math.max(0, Math.min(buttons.length - 1, index + (event.key === 'ArrowDown' ? 1 : -1)));
        event.preventDefault(); buttons[next]?.focus();
      }}>
        {result?.commits.map(commit => {
          const date = new Date(commit.timestamp * 1000);
          return <div className={`search-result-row${selected === commit.id ? ' selected' : ''}`} key={commit.id}>
            <button className="search-result-select" aria-pressed={selected === commit.id} onClick={() => onSelect(commit.id)}>
              <GitCommitHorizontal size={17} className="search-result-icon" aria-hidden="true" />
              <span className="search-result-content"><strong>{highlightMatch(commit.subject, query)}</strong>
                <span className="search-result-meta"><span title={commit.email}>{highlightMatch(commit.author, query)}</span><code>{highlightMatch(commit.id.slice(0, 7), query)}</code><time dateTime={date.toISOString()}>{date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}</time></span>
                {refs.some(ref => ref.commitId === commit.id) && <span className="search-result-refs">{refs.filter(ref => ref.commitId === commit.id).map(ref => <span className="badge" key={ref.fullName} title={ref.fullName}><GitBranch size={11} /><span>{highlightMatch(ref.name, query)}</span></span>)}</span>}
              </span>
            </button>
            <button className="search-result-reveal icon-button sm" aria-label={`Show ${commit.id.slice(0, 7)} in graph`} title="Show in graph" onClick={() => onReveal(commit.id)}><LocateFixed size={15} /></button>
          </div>;
        })}
        {result?.truncated && <p className="search-limit" role="status">Showing the first {result.commits.length} matches. Narrow your filters to find more specific commits.</p>}
      </div>
  </div>;
}
