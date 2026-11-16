import { useRef, type RefObject } from 'react';
import { useDismiss } from './ui';
import { ArrowDown, ArrowUp, RotateCcw, X } from 'lucide-react';

export interface OrderItem<Id extends string> { id: Id; visible: boolean }

/** Popover to show/hide and reorder a list of items (history columns, sidebar sections). */
export function OrderMenu<Id extends string>({ items, labels, defaults, title, ariaLabel, closeLabel, minVisible, className, triggerRef, onChange, onClose }: {
  items: OrderItem<Id>[];
  labels: Record<Id, string>;
  defaults: OrderItem<Id>[];
  title: string;
  ariaLabel: string;
  closeLabel: string;
  /** Items that must stay visible; the last ones cannot be hidden. */
  minVisible: number;
  className?: string;
  triggerRef: RefObject<HTMLButtonElement | null>;
  onChange: (items: OrderItem<Id>[]) => void;
  onClose: () => void;
}) {
  const menuRef = useRef<HTMLDivElement>(null);
  useDismiss(true, onClose, [menuRef, triggerRef], triggerRef);
  const visibleCount = items.filter(item => item.visible).length;
  const toggleVisible = (id: Id) => onChange(items.map(item => item.id !== id || (item.visible && visibleCount <= minVisible) ? item : { ...item, visible: !item.visible }));
  const move = (index: number, direction: -1 | 1) => {
    const target = index + direction;
    if (target < 0 || target >= items.length) return;
    const next = [...items];
    const [removed] = next.splice(index, 1);
    next.splice(target, 0, removed);
    onChange(next);
  };
  return <div ref={menuRef} className={`menu history-column-menu${className ? ` ${className}` : ''}`} role="dialog" aria-label={ariaLabel} onClick={event => event.stopPropagation()}>
    <div className="history-column-menu-header">
      <span>{title}</span>
      <button type="button" className="icon-button sm" aria-label={closeLabel} onClick={onClose}><X size={14} /></button>
    </div>
    <div className="history-column-menu-list">
      {items.map((item, index) => <div key={item.id} className="history-column-menu-item">
        <label className="history-column-menu-label">
          <input type="checkbox" checked={item.visible} disabled={item.visible && visibleCount <= minVisible} onChange={() => toggleVisible(item.id)} />
          <span>{labels[item.id]}</span>
        </label>
        <div className="history-column-menu-actions">
          <button type="button" className="icon-button sm" aria-label={`Move ${labels[item.id]} up`} disabled={index === 0} onClick={() => move(index, -1)}><ArrowUp size={12} /></button>
          <button type="button" className="icon-button sm" aria-label={`Move ${labels[item.id]} down`} disabled={index === items.length - 1} onClick={() => move(index, 1)}><ArrowDown size={12} /></button>
        </div>
      </div>)}
    </div>
    <div className="history-column-menu-footer">
      <button type="button" className="text-button history-column-reset-btn" onClick={() => onChange(defaults.map(item => ({ ...item })))}><RotateCcw size={12} /> Reset to default</button>
    </div>
  </div>;
}
