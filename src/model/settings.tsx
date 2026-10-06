import { createContext, useContext, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { BUILTIN_THEMES, MAX_CUSTOM_THEMES, themeTokens, validateTheme, type ThemeDefinition } from './themes';
import { MAX_COMMIT_PROFILES, validateCommitProfile, type CommitProfile } from './commitProfiles';
export type { ThemeDefinition } from './themes';

export const SETTINGS_KEY = 'gitty:settings';
export const WORKSPACE_RESET_EVENT = 'gitty:workspace-reset';
export const MONO_FONTS = ['Geist Mono Variable', 'JetBrains Mono'] as const;
export const HISTORY_COLUMN_IDS = ['refs', 'graph', 'message', 'author', 'hash', 'date'] as const;
export type HistoryColumnId = typeof HISTORY_COLUMN_IDS[number];
export type AuthorAvatarMode = 'initials' | 'gravatar';
export interface HistoryColumnConfig {
  id: HistoryColumnId;
  visible: boolean;
}
export interface Settings {
  version: 1;
  themeMode: 'fixed' | 'system';
  themeId: string;
  lightThemeId: string;
  darkThemeId: string;
  customThemes: ThemeDefinition[];
  diffView: 'unified' | 'split';
  diffWrap: boolean;
  fontSize: number;
  monoFont: string;
  paneWidths: { sidebar: number; inspector: number };
  historyColumns: HistoryColumnConfig[];
  commitProfiles: CommitProfile[];
  repositoryCommitProfiles: Record<string, string>;
  authorAvatarMode: AuthorAvatarMode;
}
export const DEFAULT_HISTORY_COLUMNS: HistoryColumnConfig[] = [
  { id: 'refs', visible: true },
  { id: 'graph', visible: true },
  { id: 'message', visible: true },
  { id: 'author', visible: true },
  { id: 'hash', visible: true },
  { id: 'date', visible: false },
];
export const DEFAULT_SETTINGS: Settings = { version: 1, themeMode: 'fixed', themeId: 'gitty-dark', lightThemeId: 'gitty-light', darkThemeId: 'gitty-dark', customThemes: [], diffView: 'unified', diffWrap: false, fontSize: 13, monoFont: MONO_FONTS[0], paneWidths: { sidebar: 240, inspector: 400 }, historyColumns: DEFAULT_HISTORY_COLUMNS, commitProfiles: [], repositoryCommitProfiles: {}, authorAvatarMode: 'initials' };
export function validateSettings(value: unknown): Settings {
  if (!value || typeof value !== 'object') throw new Error('Invalid settings.');
  const s = value as Settings;
  if (s.version !== 1) throw new Error('Unsupported settings version.');
  if (Object.keys(s).some(k => !Object.hasOwn(DEFAULT_SETTINGS, k)) || !['fixed', 'system'].includes(s.themeMode) || !['unified', 'split'].includes(s.diffView) || !['initials', 'gravatar'].includes(s.authorAvatarMode) || typeof s.diffWrap !== 'boolean' || !Number.isInteger(s.fontSize) || s.fontSize < 11 || s.fontSize > 22 || !MONO_FONTS.includes(s.monoFont as typeof MONO_FONTS[number]) || !Array.isArray(s.customThemes) || s.customThemes.length > MAX_CUSTOM_THEMES) throw new Error('Invalid preference values.');
  const customThemes = s.customThemes.map(validateTheme);
  if (!Array.isArray(s.commitProfiles) || s.commitProfiles.length > MAX_COMMIT_PROFILES) throw new Error('Invalid commit profiles.');
  const commitProfiles = s.commitProfiles.map(validateCommitProfile);
  if (new Set(commitProfiles.map(profile => profile.id)).size !== commitProfiles.length) throw new Error('Duplicate commit profile IDs.');
  if (!s.repositoryCommitProfiles || typeof s.repositoryCommitProfiles !== 'object' || Array.isArray(s.repositoryCommitProfiles) || Object.keys(s.repositoryCommitProfiles).length > 100 || Object.entries(s.repositoryCommitProfiles).some(([key, id]) => key.length > 4096 || typeof id !== 'string' || !commitProfiles.some(profile => profile.id === id))) throw new Error('Invalid repository commit profile selection.');
  if (new Set(customThemes.map(t => t.id)).size !== customThemes.length) throw new Error('Duplicate theme IDs.');
  const themes = [...BUILTIN_THEMES, ...customThemes];
  if (!themes.some(t => t.id === s.themeId) || !themes.some(t => t.id === s.lightThemeId && t.mode === 'light') || !themes.some(t => t.id === s.darkThemeId && t.mode === 'dark')) throw new Error('Missing or incompatible theme selection.');
  if (!s.paneWidths || Object.keys(s.paneWidths).some(k => !['sidebar', 'inspector'].includes(k)) || !Number.isFinite(s.paneWidths.sidebar) || s.paneWidths.sidebar < 180 || s.paneWidths.sidebar > 400 || !Number.isFinite(s.paneWidths.inspector) || s.paneWidths.inspector < 300 || s.paneWidths.inspector > 800) throw new Error('Invalid pane widths.');
  if (!Array.isArray(s.historyColumns) || s.historyColumns.length !== HISTORY_COLUMN_IDS.length) throw new Error('Invalid history columns.');
  const columnIds = new Set<string>();
  for (const col of s.historyColumns) {
    if (!col || typeof col !== 'object' || !HISTORY_COLUMN_IDS.includes(col.id as HistoryColumnId) || typeof col.visible !== 'boolean' || columnIds.has(col.id)) throw new Error('Invalid history column configuration.');
    columnIds.add(col.id);
  }
  return { ...s, customThemes, commitProfiles, repositoryCommitProfiles: { ...s.repositoryCommitProfiles }, paneWidths: { ...s.paneWidths }, historyColumns: s.historyColumns.map(c => ({ ...c })) };
}
export interface PreferenceStorage { getItem(key: string): string | null; setItem(key: string, value: string): void }
export function readSettings(storage: PreferenceStorage): { settings: Settings; error: string | null } {
  try {
    const saved = storage.getItem(SETTINGS_KEY);
    if (saved !== null) {
      const parsed = JSON.parse(saved);
      if (parsed && typeof parsed === 'object') {
        if (!('historyColumns' in parsed)) parsed.historyColumns = DEFAULT_HISTORY_COLUMNS;
        if (!('commitProfiles' in parsed)) parsed.commitProfiles = [];
        if (!('repositoryCommitProfiles' in parsed)) parsed.repositoryCommitProfiles = {};
        if (!('authorAvatarMode' in parsed)) parsed.authorAvatarMode = 'initials';
      }
      return { settings: validateSettings(parsed), error: null };
    }
    const legacy = storage.getItem('gitty:theme');
    const width = (key: string, fallback: number, min: number, max: number) => { const value = Number(storage.getItem(key)); return Number.isFinite(value) && value > 0 ? Math.max(min, Math.min(max, value)) : fallback; };
    return { settings: { ...DEFAULT_SETTINGS, ...(legacy === 'dark' || legacy === 'light' ? { themeMode: 'fixed' as const, themeId: `gitty-${legacy}` } : {}), paneWidths: { sidebar: width('gitty:sidebar-width', 240, 180, 400), inspector: width('gitty:inspector-width', 400, 300, 800) } }, error: null };
  } catch { return { settings: DEFAULT_SETTINGS, error: 'Stored preferences could not be read. Defaults are in use; the stored copy is untouched until you save.' }; }
}
export function persistSettings(storage: PreferenceStorage, settings: Settings): string | null {
  try { storage.setItem(SETTINGS_KEY, JSON.stringify(validateSettings(settings))); return null; }
  catch { return 'Preferences work for this session but could not be saved. Check local storage availability, then retry.'; }
}
export function resolveTheme(settings: Settings, dark: boolean): ThemeDefinition {
  return [...BUILTIN_THEMES, ...settings.customThemes].find(t => t.id === (settings.themeMode === 'fixed' ? settings.themeId : dark ? settings.darkThemeId : settings.lightThemeId)) ?? BUILTIN_THEMES[0];
}
interface SettingsContextValue {
  settings: Settings; theme: ThemeDefinition; themes: ThemeDefinition[];
  updateSettings: (patch: Partial<Settings> | ((current: Settings) => Partial<Settings>)) => void;
  openSettings: (section?: 'Commit profiles') => void; closeSettings: () => void; isSettingsOpen: boolean; settingsSection: 'Commit profiles' | null;
  previewTheme: (theme: ThemeDefinition | null) => void;
  storageError: string | null; retryPersistence: () => void;
  resetWorkspace: () => void;
}
const Context = createContext<SettingsContextValue | null>(null);
export function SettingsProvider({ children }: { children: ReactNode }) {
  const [initial] = useState(() => { try { return readSettings(window.localStorage); } catch { return { settings: DEFAULT_SETTINGS, error: 'Local storage is unavailable. Preferences will last for this session.' }; } });
  const [settings, setSettings] = useState(initial.settings);
  const current = useRef(settings);
  const [storageError, setStorageError] = useState(initial.error);
  const [isSettingsOpen, setOpen] = useState(false);
  const [settingsSection, setSettingsSection] = useState<'Commit profiles' | null>(null);
  const [preview, previewTheme] = useState<ThemeDefinition | null>(null);
  const [systemDark, setSystemDark] = useState(() => window.matchMedia('(prefers-color-scheme: dark)').matches);
  const theme = preview ?? resolveTheme(settings, systemDark);
  const persist = (next: Settings) => { try { setStorageError(persistSettings(window.localStorage, next)); } catch { setStorageError('Local storage is unavailable. Preferences will last for this session.'); } };
  const updateSettings: SettingsContextValue['updateSettings'] = patch => { const next = validateSettings({ ...current.current, ...(typeof patch === 'function' ? patch(current.current) : patch) }); current.current = next; setSettings(next); persist(next); };
  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const change = () => setSystemDark(media.matches);
    media.addEventListener('change', change); change();
    const key = (event: KeyboardEvent) => { if ((event.metaKey || event.ctrlKey) && event.key === ',' && !event.altKey) { event.preventDefault(); event.stopPropagation(); setSettingsSection(null); setOpen(true); } };
    window.addEventListener('keydown', key, true);
    return () => { media.removeEventListener('change', change); window.removeEventListener('keydown', key, true); };
  }, []);
  useLayoutEffect(() => {
    const root = document.documentElement;
    root.dataset.theme = theme.mode;
    root.dataset.diffWrap = String(settings.diffWrap);
    root.style.colorScheme = theme.mode;
    for (const [key, value] of Object.entries(themeTokens(theme))) root.style.setProperty(key, value);
    root.style.setProperty('--mono', `'${settings.monoFont}', monospace`);
    root.style.setProperty('--editor-font-size', `${settings.fontSize}px`);
  }, [theme, settings.diffWrap, settings.fontSize, settings.monoFont]);
  const resetWorkspace = () => {
    const paneWidths = { ...DEFAULT_SETTINGS.paneWidths };
    updateSettings({ paneWidths });
    try { for (const [key, width] of Object.entries(paneWidths)) localStorage.setItem(`gitty:${key}-width`, String(width)); } catch { setStorageError('Pane sizes reset for this session; storage is unavailable.'); }
    window.dispatchEvent(new CustomEvent(WORKSPACE_RESET_EVENT, { detail: paneWidths }));
  };
  return <Context.Provider value={{ settings, theme, themes: [...BUILTIN_THEMES, ...settings.customThemes], updateSettings, isSettingsOpen, settingsSection, openSettings: section => { setSettingsSection(section ?? null); setOpen(true); }, closeSettings: () => { setOpen(false); previewTheme(null); }, previewTheme, storageError, retryPersistence: () => persist(current.current), resetWorkspace }}>{children}</Context.Provider>;
}
export function useSettings(): SettingsContextValue { const value = useContext(Context); if (!value) throw new Error('useSettings requires SettingsProvider.'); return value; }
