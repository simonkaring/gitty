import type { ButtonHTMLAttributes } from 'react';
import { Settings as SettingsIcon } from 'lucide-react';
import { useSettings } from '../model/settings';

export function SettingsButton({ className = 'icon-button', ...props }: ButtonHTMLAttributes<HTMLButtonElement>) {
  const { openSettings } = useSettings();
  return <button type="button" className={className} title="Settings (⌘ / Ctrl+,)" aria-label="Open settings" {...props} onClick={() => openSettings()}><SettingsIcon size={18} /></button>;
}
