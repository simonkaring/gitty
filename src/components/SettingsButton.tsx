import type { ButtonHTMLAttributes } from 'react';
import { useIcons } from './icons';
import { useSettings } from '../model/settings';

export function SettingsButton({ className = 'icon-button', ...props }: ButtonHTMLAttributes<HTMLButtonElement>) {
  const { Settings } = useIcons();
  const { openSettings } = useSettings();
  return <button type="button" className={className} title="Settings (⌘ / Ctrl+,)" aria-label="Open settings" {...props} onClick={() => openSettings()}><SettingsIcon size={18} /></button>;
}
