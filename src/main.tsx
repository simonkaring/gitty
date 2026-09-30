import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './styles.css';
import { SettingsProvider } from './model/settings';
import { SettingsDialog } from './components/Settings';

const isMac = typeof navigator !== 'undefined' && (/Mac|iPhone|iPod|iPad/i.test(navigator.userAgent) || (navigator as { userAgentData?: { platform?: string } }).userAgentData?.platform === 'macOS');
if (isMac && typeof document !== 'undefined') {
  document.documentElement.dataset.platform = 'macos';
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode><SettingsProvider><App /><SettingsDialog /></SettingsProvider></React.StrictMode>,
);
