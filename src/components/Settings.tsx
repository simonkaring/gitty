import { useEffect, useRef, useState, type ButtonHTMLAttributes } from 'react';
import { Settings as SettingsIcon } from 'lucide-react';
import { Dialog } from './ui';
import { DEFAULT_SETTINGS, MONO_FONTS, useSettings } from '../model/settings';
import { COLOR_KEYS, MAX_CUSTOM_THEMES, MAX_THEME_FILE_BYTES, contrastRatio, exportTheme, importTheme, isColor, validateTheme, type ThemeDefinition } from '../model/themes';
import { MAX_COMMIT_PROFILES, validateCommitProfile, type CommitProfile } from '../model/commitProfiles';
import { IntegrationsSettings } from './IntegrationsSettings';

export function SettingsButton({ className = 'icon-button', ...props }: ButtonHTMLAttributes<HTMLButtonElement>) {
  const { openSettings } = useSettings();
  return <button type="button" className={className} title="Settings (⌘ / Ctrl+,)" aria-label="Open settings" {...props} onClick={() => openSettings()}><SettingsIcon size={18} /></button>;
}
const newId = () => `custom-${crypto.randomUUID()}`;
const sections = ['Appearance', 'Commit profiles', 'Integrations', 'Editor & diffs', 'Workspace reset', 'About / shortcuts'] as const;
type Section = typeof sections[number];

export function SettingsDialog() {
  const api = useSettings();
  const { settings, theme, themes, updateSettings } = api;
  const [section, setSection] = useState<Section>('Appearance');
  const [draft, setDraft] = useState<ThemeDefinition | null>(null);
  const [profileDraft, setProfileDraft] = useState<CommitProfile | null>(null);
  const [baseline, setBaseline] = useState<ThemeDefinition | null>(null);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [confirmClose, setConfirmClose] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [resetDone, setResetDone] = useState(false);
  const [colorErrors, setColorErrors] = useState<Record<string, string>>({});
  const importGeneration = useRef(0);
  const [importing, setImporting] = useState(false);
  const dirty = draft !== null && (JSON.stringify(draft) !== JSON.stringify(baseline) || !settings.customThemes.some(t => t.id === draft.id) || Object.keys(colorErrors).length > 0);
  useEffect(() => { if (api.isSettingsOpen && api.settingsSection) setSection(api.settingsSection); }, [api.isSettingsOpen, api.settingsSection]);
  function finish() {
    importGeneration.current += 1; setImporting(false);
    setDraft(null); setProfileDraft(null); setBaseline(null); setColorErrors({}); setConfirmClose(false); setConfirmDelete(false); setError(''); setMessage(''); api.closeSettings();
  }
  function requestClose() { if (dirty) setConfirmClose(true); else finish(); }
  function edit(next: ThemeDefinition) {
    setDraft(next); setBaseline(next); setColorErrors({}); setError(''); setMessage(''); api.previewTheme(next); setConfirmDelete(false);
  }
  function changeDraft(next: ThemeDefinition) { setDraft(next); api.previewTheme(next); }
  function cancelEdit() { setDraft(null); setBaseline(null); setColorErrors({}); api.previewTheme(null); setConfirmClose(false); setConfirmDelete(false); setError(''); setMessage(''); }
  function save() {
    try {
      if (!draft || Object.keys(colorErrors).length) throw new Error('Correct invalid colors before saving.');
      const valid = validateTheme(draft);
      const customThemes = [...settings.customThemes.filter(t => t.id !== valid.id), valid];
      updateSettings({ customThemes, themeMode: 'fixed', themeId: valid.id,
        lightThemeId: settings.lightThemeId === valid.id && valid.mode !== 'light' ? 'gitty-light' : settings.lightThemeId,
        darkThemeId: settings.darkThemeId === valid.id && valid.mode !== 'dark' ? 'gitty-dark' : settings.darkThemeId });
      cancelEdit(); setMessage('Theme saved and selected.');
    } catch (e) { setError(e instanceof Error ? e.message : 'Unable to save theme.'); }
  }
  function remove() {
    if (!draft) return;
    updateSettings({ customThemes: settings.customThemes.filter(t => t.id !== draft.id), themeId: settings.themeId === draft.id ? `gitty-${draft.mode}` : settings.themeId, lightThemeId: settings.lightThemeId === draft.id ? 'gitty-light' : settings.lightThemeId, darkThemeId: settings.darkThemeId === draft.id ? 'gitty-dark' : settings.darkThemeId });
    cancelEdit(); setMessage('Custom theme deleted.');
  }
  async function loadFile(file?: File) {
    if (!file) return;
    const generation = ++importGeneration.current;
    setImporting(true);
    try {
      if (file.size > MAX_THEME_FILE_BYTES) throw new Error('Theme file is too large (100 KB maximum).');
      const imported = importTheme(await file.text());
      if (generation !== importGeneration.current) return;
      edit({ ...imported, id: newId() }); setMessage('Imported as an unsaved copy. Review and save to keep it.');
    } catch (e) { if (generation === importGeneration.current) setError(e instanceof Error ? e.message : 'Could not read theme file.'); }
    finally { if (generation === importGeneration.current) setImporting(false); }
  }
  function download() {
    try {
      const source = draft ?? theme;
      const json = exportTheme({ ...source, id: source.id.startsWith('custom-') ? source.id : newId() });
      const url = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
      const link = document.createElement('a'); link.href = url; link.download = `${source.name.replace(/[^a-z0-9-]/gi, '-')}.gitty-theme.json`; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
      setMessage('Theme JSON exported.');
    } catch (e) { setError(e instanceof Error ? e.message : 'Export failed.'); }
  }
  function saveProfile() {
    try {
      const profile = validateCommitProfile(profileDraft);
      updateSettings({ commitProfiles: [...settings.commitProfiles.filter(item => item.id !== profile.id), profile] });
      setProfileDraft(null); setError(''); setMessage('Commit profile saved.');
    } catch (e) { setError(e instanceof Error ? e.message : 'Unable to save commit profile.'); }
  }
  function deleteProfile(id: string) {
    updateSettings({ commitProfiles: settings.commitProfiles.filter(profile => profile.id !== id), repositoryCommitProfiles: Object.fromEntries(Object.entries(settings.repositoryCommitProfiles).filter(([, selected]) => selected !== id)) });
    setProfileDraft(null); setMessage('Commit profile deleted.');
  }
  const choice = (label: string, value: string, onChange: (id: string) => void, mode?: 'light' | 'dark') => <label className="settings-field">{label}<select value={value} disabled={!!draft} onChange={e => onChange(e.target.value)}>{themes.filter(t => !mode || t.mode === mode).map(t => <option key={t.id} value={t.id}>{t.name}</option>)}</select></label>;
  if (!api.isSettingsOpen) return null;
  return <Dialog title="Settings" size="lg" className="settings-dialog" onClose={requestClose}>
    {confirmClose && <div className="settings-notice" role="alert"><p>Discard your unsaved theme edits?</p><button className="secondary-button" onClick={() => setConfirmClose(false)} autoFocus>Keep editing</button> <button className="secondary-button" onClick={finish}>Discard and close</button></div>}
    {api.storageError && <div className="settings-notice" role="alert">{api.storageError} <button className="text-button" onClick={api.retryPersistence}>Retry saving</button></div>}
    <div className="settings-layout"><nav aria-label="Settings sections">{sections.map(s => <button key={s} aria-current={section === s ? 'page' : undefined} onClick={() => setSection(s)}>{s}</button>)}</nav>
    <div className="settings-content">
      <div hidden={section !== 'Integrations'}><IntegrationsSettings /></div>
      <section hidden={section !== 'Appearance'} aria-labelledby="appearance-heading"><h3 id="appearance-heading">Appearance</h3>
        <label className="settings-field">Theme behavior<select value={settings.themeMode} disabled={!!draft} onChange={e => updateSettings({ themeMode: e.target.value as 'fixed' | 'system' })}><option value="fixed">Fixed theme</option><option value="system">Follow system appearance</option></select></label>
        {settings.themeMode === 'fixed' ? choice('Theme', settings.themeId, themeId => updateSettings({ themeId })) : <div className="settings-pair">{choice('Light appearance', settings.lightThemeId, lightThemeId => updateSettings({ lightThemeId }), 'light')}{choice('Dark appearance', settings.darkThemeId, darkThemeId => updateSettings({ darkThemeId }), 'dark')}</div>}
        <p>Active: <strong>{theme.name}</strong>{draft && ' · unsaved preview'}. Custom previews update the whole app until saved or canceled.</p>
        {!draft && <div className="settings-actions"><button className="secondary-button" disabled={importing || settings.customThemes.length >= MAX_CUSTOM_THEMES} onClick={() => edit({ ...theme, id: newId(), name: `${theme.name.slice(0, 50)} copy`, colors: { ...theme.colors } })}>Duplicate & customize</button>{theme.id.startsWith('custom-') && <button className="secondary-button" disabled={importing} onClick={() => edit({ ...theme, colors: { ...theme.colors } })}>Edit / rename</button>}<label className="settings-import">Import JSON<input aria-label="Import theme JSON" type="file" accept=".json,application/json" disabled={importing || settings.customThemes.length >= MAX_CUSTOM_THEMES} onChange={e => { void loadFile(e.target.files?.[0]); e.target.value = ''; }} /></label>{importing && <span role="status">Reading theme…</span>}</div>}
        <button className="text-button" disabled={Object.keys(colorErrors).length > 0} onClick={download}>Export {draft ? 'preview' : 'active theme'} JSON</button>
        {draft && <div className="theme-editor"><h3>Custom theme editor</h3><label className="settings-field">Theme name<input value={draft.name} maxLength={60} onChange={e => changeDraft({ ...draft, name: e.target.value })} /></label><label className="settings-field">Appearance<select value={draft.mode} onChange={e => changeDraft({ ...draft, mode: e.target.value as 'light' | 'dark' })}><option value="light">Light</option><option value="dark">Dark</option></select></label>
          <p>Colors use #RRGGBB; shadow and backdrop also accept #RRGGBBAA.</p>
          <div className="theme-color-grid">{COLOR_KEYS.map(key => <label key={key} className="theme-color"><span>{key.replace(/([A-Z])/g, ' $1')}</span><input type="color" aria-label={`${key} color picker`} value={draft.colors[key].slice(0, 7)} onChange={e => { const next = { ...colorErrors }; delete next[key]; setColorErrors(next); changeDraft({ ...draft, colors: { ...draft.colors, [key]: e.target.value } }); }} /><input aria-label={`${key} hex color`} aria-invalid={Object.hasOwn(colorErrors, key)} value={colorErrors[key] ?? draft.colors[key]} onChange={e => { const value = e.target.value; if (isColor(value, key === 'shadow' || key === 'backdrop')) { const next = { ...colorErrors }; delete next[key]; setColorErrors(next); changeDraft({ ...draft, colors: { ...draft.colors, [key]: value } }); } else setColorErrors({ ...colorErrors, [key]: value }); }} /></label>)}</div>
          {Object.keys(colorErrors).length > 0 && <p role="alert">Invalid hex colors: {Object.keys(colorErrors).join(', ')}. Preview retains their last valid values.</p>}
          <div className="settings-actions"><button className="primary-button" disabled={!!Object.keys(colorErrors).length || !draft.name.trim()} onClick={save}>Save theme</button><button className="secondary-button" onClick={cancelEdit}>Cancel edits</button><button className="secondary-button" onClick={() => { if (baseline) { changeDraft(baseline); setColorErrors({}); } }}>Reset edits</button>{settings.customThemes.some(t => t.id === draft.id) && <button className="secondary-button" onClick={() => setConfirmDelete(true)}>Delete theme</button>}</div>
          {confirmDelete && <div className="settings-notice" role="alert"><p>Delete “{draft.name}”? Any selections using it will return to Gitty defaults.</p><button className="secondary-button" onClick={() => setConfirmDelete(false)}>Keep theme</button> <button className="secondary-button" onClick={remove}>Confirm deletion</button></div>}
        </div>}
        <ThemePreview theme={theme} />
        <h3>Contrast feedback</h3><ul className="contrast-list">{[['Text', 'text', 'bg'], ['Secondary text', 'secondary', 'bg'], ['Muted text', 'muted', 'bg'], ['Button label', 'buttonForeground', 'accentText'], ['Added diff', 'green', 'greenWash'], ['Removed diff', 'red', 'redWash']].map(([label, foreground, background]) => { const ratio = contrastRatio(theme.colors[foreground], theme.colors[background]); return <li key={label}>{label}: <strong>{ratio.toFixed(2)}:1</strong> — {ratio >= 4.5 ? 'AA normal text' : ratio >= 3 ? 'Large text only' : 'Low contrast'}</li>; })}</ul><p>Guidance only: 4.5:1 is the WCAG AA threshold for normal text. Custom colors remain your choice.</p>
      </section>
      <section hidden={section !== 'Commit profiles'} aria-labelledby="profiles-heading"><h3 id="profiles-heading">Commit profiles</h3><p>Save names and email addresses to choose from when committing. “Commit as” selections are remembered per worktree on this device; use a repository’s toolbar → Git identity… to explicitly apply a profile to its Git config.</p>
        {settings.commitProfiles.map(profile => <div className="commit-profile-row" key={profile.id}><span><strong>{profile.name}</strong><small>{profile.email}</small></span><button className="secondary-button" onClick={() => { setProfileDraft({ ...profile }); setError(''); }}>Edit</button><button className="secondary-button" onClick={() => deleteProfile(profile.id)}>Delete</button></div>)}
        {!settings.commitProfiles.length && <p>No saved profiles. Gitty uses each repository’s configured Git identity by default.</p>}
        {!profileDraft && <button className="secondary-button" disabled={settings.commitProfiles.length >= MAX_COMMIT_PROFILES} onClick={() => { setProfileDraft({ id: `profile-${crypto.randomUUID()}`, name: '', email: '' }); setError(''); }}>Add profile</button>}
        {profileDraft && <div className="profile-editor"><label className="settings-field">Name<input autoComplete="name" maxLength={120} value={profileDraft.name} onChange={e => setProfileDraft({ ...profileDraft, name: e.target.value })} /></label><label className="settings-field">Email<input type="email" autoComplete="email" maxLength={254} value={profileDraft.email} onChange={e => setProfileDraft({ ...profileDraft, email: e.target.value })} /></label><div className="settings-actions"><button className="primary-button" onClick={saveProfile}>Save profile</button><button className="secondary-button" onClick={() => { setProfileDraft(null); setError(''); }}>Cancel</button></div></div>}
      </section>
      <section hidden={section !== 'Editor & diffs'} aria-labelledby="editor-heading"><h3 id="editor-heading">Editor & diffs</h3><label className="settings-field">Default diff layout<select value={settings.diffView} onChange={e => updateSettings({ diffView: e.target.value as 'unified' | 'split' })}><option value="unified">Unified</option><option value="split">Side by side</option></select></label><label className="settings-checkbox"><input type="checkbox" checked={settings.diffWrap} onChange={e => updateSettings({ diffWrap: e.target.checked })} />Wrap long diff lines</label><label className="settings-field">Code font (bundled locally)<select value={settings.monoFont} onChange={e => updateSettings({ monoFont: e.target.value })}>{MONO_FONTS.map(font => <option key={font}>{font}</option>)}</select></label><label className="settings-field">Code size: {settings.fontSize}px<input type="range" min="11" max="22" value={settings.fontSize} onChange={e => updateSettings({ fontSize: Number(e.target.value) })} /></label><ThemePreview theme={theme} /><button className="secondary-button" onClick={() => updateSettings({ diffView: DEFAULT_SETTINGS.diffView, diffWrap: DEFAULT_SETTINGS.diffWrap, fontSize: DEFAULT_SETTINGS.fontSize, monoFont: DEFAULT_SETTINGS.monoFont })}>Reset editor preferences</button></section>
      <section hidden={section !== 'Workspace reset'} aria-labelledby="reset-heading"><h3 id="reset-heading">Workspace reset</h3><p>Restore sidebar and inspector widths to 240px and 400px.</p><button className="secondary-button" onClick={() => { api.resetWorkspace(); setResetDone(true); }}>Reset pane sizes</button>{resetDone && <p role="status">Default pane sizes restored.</p>}</section>
      <section hidden={section !== 'About / shortcuts'} aria-labelledby="about-heading"><h3 id="about-heading">About Gitty</h3><p>Gitty 0.1.0 — a graph-first desktop Git client.</p><p>Preferences are shared by the native and demo workspaces on this device. Fonts and themes are bundled locally. Theme import and export use local JSON files.</p><h3>Settings shortcuts</h3><dl className="settings-shortcuts"><dt><kbd>⌘ / Ctrl</kbd> + <kbd>,</kbd></dt><dd>Open settings from anywhere</dd><dt><kbd>Esc</kbd></dt><dd>Close settings (unsaved theme edits prompt first)</dd><dt><kbd>Tab</kbd> / <kbd>Shift Tab</kbd></dt><dd>Move between controls inside the dialog</dd></dl><p>Standard controls support arrow keys, Space, and Enter. Changes to preferences save immediately; custom theme edits save only when you choose Save theme.</p></section>
      <p role="status" className="settings-status">{message}</p>{error && <p role="alert" className="settings-error">{error}</p>}
    </div></div>
  </Dialog>;
}

function ThemePreview({ theme }: { theme: ThemeDefinition }) {
  const { settings } = useSettings();
  return <div className="theme-preview"><h3>Live preview</h3><div className="preview-graph"><svg viewBox="0 0 240 100" role="img" aria-label="Sample commit graph with eight lanes, selection, merge and HEAD markers">{Array.from({ length: 8 }, (_, i) => <g key={i} stroke={theme.colors[`graphLane${i + 1}`]} fill={theme.colors.bg}><path d={`M${16 + i * 29} 5 V95`} strokeWidth="2" /><circle cx={16 + i * 29} cy={30 + i % 3 * 20} r="5" strokeWidth="3" /></g>)}<circle cx="16" cy="30" r="10" fill="none" stroke={theme.colors.graphSelection} strokeWidth="2" /><path d="M45 50 Q45 80 74 70" fill="none" stroke={theme.colors.graphMerge} strokeWidth="3" /><rect x="11" y="80" width="10" height="10" fill={theme.colors.graphHead} /></svg><div><strong>Refine commit inspection</strong><p className="muted">main · HEAD · a31f9c2</p></div></div><div className={`native-diff ${settings.diffView === 'split' ? 'preview-split' : ''}`}><pre className="remove">− const theme = 'default';</pre><pre className="add">+ const theme = 'yours'; // A longer line to preview code wrapping and your chosen font.</pre></div><div className="settings-actions"><button className="primary-button" type="button">Primary control</button><button className="secondary-button" type="button">Secondary control</button><input aria-label="Sample input" placeholder="Sample input" /></div></div>;
}
