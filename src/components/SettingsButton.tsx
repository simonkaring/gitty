import type { ButtonHTMLAttributes } from 'react';
import { Icons } from './icons';
import { useSettings } from '../model/settings';

export function SettingsButton({ className = 'icon-button', ...props }: ButtonHTMLAttributes<HTMLButtonElement>) {
  const { openSettings } = useSettings();
  return <button type="button" className={className} title="Settings (⌘ / Ctrl+,)" aria-label="Open settings" {...props} onClick={() => openSettings()}><Icons.Settings size={18} /></button>;
}
