import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './styles.css';
import { SettingsProvider } from './model/settings';
import { SettingsDialog } from './components/Settings';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode><SettingsProvider><App /><SettingsDialog /></SettingsProvider></React.StrictMode>,
);
