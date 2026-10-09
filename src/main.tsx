import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './styles.css';
import { SettingsProvider } from './model/settings';
import { applyScale, loadScale } from './model/scale';

applyScale(loadScale());

const isMac = typeof navigator !== 'undefined' && (/Mac|iPhone|iPod|iPad/i.test(navigator.userAgent) || (navigator as { userAgentData?: { platform?: string } }).userAgentData?.platform === 'macOS');
if (isMac && typeof document !== 'undefined') {
  document.documentElement.dataset.platform = 'macos';
} else if (/Windows/i.test(navigator.userAgent)) {
  document.documentElement.dataset.platform = 'windows';
} else if (/Linux/i.test(navigator.userAgent)) {
  document.documentElement.dataset.platform = 'linux';
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode><SettingsProvider><App /></SettingsProvider></React.StrictMode>,
);
