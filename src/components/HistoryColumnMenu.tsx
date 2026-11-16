import type { RefObject } from 'react';
import type { HistoryColumnConfig, HistoryColumnId } from '../model/settings';
import { DEFAULT_HISTORY_COLUMNS } from '../model/settings';
import { OrderMenu } from './OrderMenu';

export const COLUMN_LABELS: Record<HistoryColumnId, string> = {
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
  return <OrderMenu items={columns} labels={COLUMN_LABELS} defaults={DEFAULT_HISTORY_COLUMNS} title="Columns" ariaLabel="History columns settings" closeLabel="Close column settings" minVisible={1} triggerRef={triggerRef} onChange={onChange} onClose={onClose} />;
}
