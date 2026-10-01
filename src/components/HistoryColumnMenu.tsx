import { useRef, type RefObject } from 'react';
import { useDismiss } from './ui';
import { ArrowDown, ArrowUp, RotateCcw, X } from 'lucide-react';
import type { HistoryColumnConfig, HistoryColumnId } from '../model/settings';
import { DEFAULT_HISTORY_COLUMNS } from '../model/settings';

const COLUMN_LABELS: Record<HistoryColumnId, string> = {
  refs: 'Branch / tag',
  graph: 'Graph',
  message: 'Commit message',
  author: 'Author',
  hash: 'Commit',
  date: 'Date',
};

interface HistoryColumnMenuProps {
  columns: HistoryColumnConfig[];
  triggerRef: RefObject<HTMLButtonElement | null>;
  onChange: (columns: HistoryColumnConfig[]) => void;
  onClose: () => void;
}

export function HistoryColumnMenu({ columns, triggerRef, onChange, onClose }: HistoryColumnMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);

  useDismiss(true, onClose, [menuRef, triggerRef], triggerRef);

  const toggleVisible = (id: HistoryColumnId) => {
    const visibleCount = columns.filter(c => c.visible).length;
    onChange(
      columns.map(col => {
        if (col.id === id) {
          // Prevent hiding all columns
          if (col.visible && visibleCount <= 1) return col;
          return { ...col, visible: !col.visible };
        }
        return col;
      })
    );
  };

  const move = (index: number, direction: -1 | 1) => {
    const targetIndex = index + direction;
    if (targetIndex < 0 || targetIndex >= columns.length) return;
    const next = [...columns];
    const [removed] = next.splice(index, 1);
    next.splice(targetIndex, 0, removed);
    onChange(next);
  };

  const resetToDefault = () => {
    onChange(DEFAULT_HISTORY_COLUMNS.map(c => ({ ...c })));
  };

  return (
    <div
      ref={menuRef}
      className="menu history-column-menu"
      role="dialog"
      aria-label="History columns settings"
      onClick={e => e.stopPropagation()}
    >
      <div className="history-column-menu-header">
        <span>Columns</span>
        <button
          type="button"
          className="icon-button sm"
          aria-label="Close column settings"
          onClick={onClose}
        >
          <X size={14} />
        </button>
      </div>

      <div className="history-column-menu-list">
        {columns.map((col, index) => {
          const visibleCount = columns.filter(c => c.visible).length;
          const isOnlyVisible = col.visible && visibleCount <= 1;

          return (
            <div key={col.id} className="history-column-menu-item">
              <label className="history-column-menu-label">
                <input
                  type="checkbox"
                  checked={col.visible}
                  disabled={isOnlyVisible}
                  onChange={() => toggleVisible(col.id)}
                />
                <span>{COLUMN_LABELS[col.id]}</span>
              </label>
              <div className="history-column-menu-actions">
                <button
                  type="button"
                  className="icon-button sm"
                  aria-label={`Move ${COLUMN_LABELS[col.id]} up`}
                  disabled={index === 0}
                  onClick={() => move(index, -1)}
                >
                  <ArrowUp size={12} />
                </button>
                <button
                  type="button"
                  className="icon-button sm"
                  aria-label={`Move ${COLUMN_LABELS[col.id]} down`}
                  disabled={index === columns.length - 1}
                  onClick={() => move(index, 1)}
                >
                  <ArrowDown size={12} />
                </button>
              </div>
            </div>
          );
        })}
      </div>

      <div className="history-column-menu-footer">
        <button
          type="button"
          className="text-button history-column-reset-btn"
          onClick={resetToDefault}
        >
          <RotateCcw size={12} /> Reset to default
        </button>
      </div>
    </div>
  );
}
