import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, SETTINGS_KEY, persistSettings, readSettings, resolveTheme, validateSettings } from './settings';
import { BUILTIN_THEMES, COLOR_KEYS, contrastRatio, exportTheme, importTheme, themeTokens, validateTheme } from './themes';
import { commitProfileRepositoryKey, validateCommitProfile } from './commitProfiles';
import type { RepositorySession } from './repository';

const custom = () => ({ ...BUILTIN_THEMES[0], id: 'custom-test', name: 'My theme', colors: { ...BUILTIN_THEMES[0].colors } });
function storage(entries: Record<string, string> = {}) {
  const values = new Map(Object.entries(entries));
  return { values, getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
}
describe('local preferences', () => {
  it('migrates legacy appearance and clamps existing pane sizes without altering old keys', () => {
    const store = storage({ 'gitty:theme': 'dark', 'gitty:sidebar-width': '900', 'gitty:inspector-width': '510' });
    const { settings, error } = readSettings(store);
    expect(error).toBeNull();
    expect(settings).toMatchObject({ themeMode: 'fixed', themeId: 'gitty-dark', paneWidths: { sidebar: 400, inspector: 510 } });
    expect(persistSettings(store, settings)).toBeNull();
    expect(readSettings(store).settings).toEqual(settings);
    expect(store.getItem('gitty:theme')).toBe('dark');
  });
  it('keeps corrupt and future stored data untouched and reports fallback', () => {
    for (const value of ['{broken', JSON.stringify({ ...DEFAULT_SETTINGS, version: 2 }), JSON.stringify({ ...DEFAULT_SETTINGS, diffWrap: 'yes' }), JSON.stringify({ ...DEFAULT_SETTINGS, authorAvatarMode: 'remote' })]) {
      const store = storage({ [SETTINGS_KEY]: value });
      expect(readSettings(store).error).toBeTruthy();
      expect(readSettings(store).settings).toEqual(DEFAULT_SETTINGS);
      expect(store.getItem(SETTINGS_KEY)).toBe(value);
    }
  });
  it('handles storage access and quota failures', () => {
    const broken = { getItem: () => { throw Error('denied'); }, setItem: () => { throw Error('quota'); } };
    expect(readSettings(broken).error).toBeTruthy();
    expect(persistSettings(broken, DEFAULT_SETTINGS)).toContain('session');
  });
  it('rejects invalid ranges, references, modes, fonts and duplicates', () => {
    for (const patch of [{ fontSize: 10 }, { fontSize: 13.5 }, { monoFont: 'https://font' }, { paneWidths: { sidebar: Infinity, inspector: 400 } }, { themeId: 'missing' }, { lightThemeId: 'gitty-dark' }, { customThemes: [custom(), custom()] }, { customThemes: Array(31).fill(custom()) }, { historyColumns: [] }, { historyColumns: [{ id: 'unknown', visible: true }] }, { historyColumns: DEFAULT_SETTINGS.historyColumns.slice(0, 5) }]) expect(() => validateSettings({ ...DEFAULT_SETTINGS, ...patch })).toThrow();
  });
  it('migrates older settings missing historyColumns to default columns', () => {
    const withoutCols = { ...DEFAULT_SETTINGS };
    delete (withoutCols as any).historyColumns;
    const store = storage({ [SETTINGS_KEY]: JSON.stringify(withoutCols) });
    const { settings, error } = readSettings(store);
    expect(error).toBeNull();
    expect(settings.historyColumns).toEqual(DEFAULT_SETTINGS.historyColumns);
    expect(settings.commitProfiles).toEqual([]);
    expect(settings.repositoryCommitProfiles).toEqual({});
    expect(settings.authorAvatarMode).toBe('gravatar');
  });
  it('preserves saved preferences while migrating avatar mode and persists its selection', () => {
    expect(readSettings(storage()).settings.authorAvatarMode).toBe('gravatar');
    const older = { ...DEFAULT_SETTINGS, themeId: 'dracula', diffWrap: true } as any;
    delete older.authorAvatarMode;
    const store = storage({ [SETTINGS_KEY]: JSON.stringify(older) });
    const migrated = readSettings(store).settings;
    expect(migrated).toMatchObject({ themeId: 'dracula', diffWrap: true, authorAvatarMode: 'gravatar' });
    expect(persistSettings(store, { ...migrated, authorAvatarMode: 'initials' })).toBeNull();
    expect(readSettings(store).settings.authorAvatarMode).toBe('initials');
  });
  it('saves profiles and per-worktree selections without changing other settings', () => {
    const store = storage();
    const profile = { id: 'profile-test', name: 'Zoë', email: 'zoe@example.org' };
    const session = { root: '/repo', location: { kind: 'native', path: '/repo' } } as RepositorySession;
    const key = commitProfileRepositoryKey(session);
    expect(key).not.toBe(commitProfileRepositoryKey({ ...session, root: '/other' }));
    expect(key).not.toBe(commitProfileRepositoryKey({ ...session, location: { kind: 'wsl', distribution: 'Ubuntu', path: '/repo' } }));
    expect(persistSettings(store, { ...DEFAULT_SETTINGS, commitProfiles: [profile], repositoryCommitProfiles: { [key]: profile.id } })).toBeNull();
    expect(readSettings(store).settings).toMatchObject({ commitProfiles: [profile], repositoryCommitProfiles: { [key]: profile.id } });
  });
  it('migrates graph avatar nodes to off and persists the toggle independently of avatar mode', () => {
    const older = { ...DEFAULT_SETTINGS, themeId: 'dracula', authorAvatarMode: 'initials' } as any;
    delete older.graphAuthorAvatars;
    const store = storage({ [SETTINGS_KEY]: JSON.stringify(older) });
    const { settings, error } = readSettings(store);
    expect(error).toBeNull();
    expect(settings).toMatchObject({ themeId: 'dracula', authorAvatarMode: 'initials', graphAuthorAvatars: false });
    expect(persistSettings(store, { ...settings, graphAuthorAvatars: true })).toBeNull();
    expect(readSettings(store).settings).toMatchObject({ authorAvatarMode: 'initials', graphAuthorAvatars: true });
    expect(persistSettings(store, settings)).toBeNull();
    expect(readSettings(store).settings.graphAuthorAvatars).toBe(false);
    for (const graphAuthorAvatars of ['true', null, 1]) expect(() => validateSettings({ ...DEFAULT_SETTINGS, graphAuthorAvatars })).toThrow();
  });
  it('rejects malformed identity fields and broken selections', () => {
    const valid = { id: 'profile-1', name: 'Valid', email: 'valid@example.org' };
    for (const profile of [{ ...valid, name: 'bad\nname' }, { ...valid, email: 'bad>\n@example.org' }, { ...valid, email: 'missing-at' }, { ...valid, id: '--bad' }]) expect(() => validateCommitProfile(profile)).toThrow();
    expect(() => validateSettings({ ...DEFAULT_SETTINGS, commitProfiles: [valid, valid] })).toThrow();
    expect(() => validateSettings({ ...DEFAULT_SETTINGS, repositoryCommitProfiles: { repo: valid.id } })).toThrow();
  });
  it('persists reordered and hidden history columns across reloads', () => {
    const store = storage();
    const historyColumns = DEFAULT_SETTINGS.historyColumns.map(col => ({ ...col, visible: col.id === 'date' || col.id === 'graph' })).reverse();
    expect(persistSettings(store, { ...DEFAULT_SETTINGS, historyColumns })).toBeNull();
    expect(readSettings(store)).toMatchObject({ settings: { historyColumns }, error: null });
  });
  it('resolves system pairs and fixed themes independently of OS appearance', () => {
    const settings = { ...DEFAULT_SETTINGS, themeMode: 'system' as const, lightThemeId: 'catppuccin-latte', darkThemeId: 'nord' };
    expect(resolveTheme(settings, false).id).toBe('catppuccin-latte');
    expect(resolveTheme(settings, true).id).toBe('nord');
    expect(resolveTheme({ ...settings, themeMode: 'fixed', themeId: 'dracula' }, false).id).toBe('dracula');
  });
});
describe('theme files and render tokens', () => {
  it('round trips a complete versioned custom theme', () => { expect(importTheme(exportTheme(custom()))).toEqual(custom()); });
  it('rejects missing or unknown tokens, CSS injection, oversized files and future versions', () => {
    const missing = custom(); delete missing.colors.graphHead;
    const unknown = custom(); unknown.colors.remote = '#ffffff';
    const invalid = custom(); invalid.colors.bg = 'url(https://example.org)';
    const translucent = custom(); translucent.colors.text = '#ffffff88';
    for (const theme of [missing, unknown, invalid, translucent, { ...custom(), name: 'x'.repeat(61) }, { ...custom(), id: 'gitty-light' }]) expect(() => validateTheme(theme)).toThrow();
    expect(() => importTheme(JSON.stringify({ version: 2, theme: custom() }))).toThrow();
    expect(() => importTheme(' '.repeat(100_001))).toThrow();
  });
  it('renders complete semantic and graph tokens for all builtins', () => {
    expect(BUILTIN_THEMES).toHaveLength(8);
    for (const theme of BUILTIN_THEMES) {
      expect(Object.keys(theme.colors)).toEqual([...COLOR_KEYS]);
      expect(() => validateTheme({ ...theme, id: 'custom-check' })).not.toThrow();
      const tokens = themeTokens(theme);
      expect(tokens['--accent-text']).toBe(theme.colors.accentText);
      expect(tokens['--button-foreground']).toBe(theme.colors.buttonForeground);
      expect(tokens['--graph-lane8']).toBe(theme.colors.graphLane8);
      expect(tokens['--shadow']).toBe(`0 12px 40px ${theme.colors.shadow}`);
    }
  });
  it('keeps Gitty presets at WCAG AA for text on every surface', () => {
    for (const { colors } of BUILTIN_THEMES.slice(0, 2)) {
      for (const fg of ['text', 'secondary', 'muted']) for (const bg of ['bg', 'chrome', 'sidebar', 'raised', 'subtle']) expect(contrastRatio(colors[fg], colors[bg])).toBeGreaterThanOrEqual(4.5);
      for (const [fg, bg] of [['buttonForeground', 'accentText'], ['accentText', 'accentWash'], ['accentText', 'selected'], ['green', 'greenWash'], ['red', 'redWash']]) expect(contrastRatio(colors[fg], colors[bg])).toBeGreaterThanOrEqual(4.5);
    }
  });
  it('computes WCAG luminance contrast with symmetry and known endpoints', () => {
    expect(contrastRatio('#000000', '#ffffff')).toBe(21);
    expect(contrastRatio('#ffffff', '#ffffff')).toBe(1);
    expect(contrastRatio('#777777', '#ffffff')).toBeCloseTo(4.478, 3);
    expect(contrastRatio('#ffffff', '#777777')).toBe(contrastRatio('#777777', '#ffffff'));
    expect(() => contrastRatio('red', '#ffffff')).toThrow();
  });
});
