export interface ThemeDefinition {
  id: string;
  name: string;
  mode: 'light' | 'dark';
  colors: Record<string, string>;
}

export const COLOR_KEYS = ['bg', 'chrome', 'sidebar', 'raised', 'subtle', 'hover', 'border', 'borderStrong', 'text', 'secondary', 'muted', 'accent', 'accentText', 'accentWash', 'selected', 'green', 'greenWash', 'red', 'redWash', 'buttonForeground', 'shadow', 'backdrop', 'graphLane1', 'graphLane2', 'graphLane3', 'graphLane4', 'graphLane5', 'graphLane6', 'graphLane7', 'graphLane8', 'graphSelection', 'graphMerge', 'graphHead'] as const;
// Gitty defaults: neutral zinc surfaces with a single burnt-orange accent. Red leans rose so it never reads as the accent.
const light = ['#fafafa', '#f3f3f4', '#f5f5f6', '#ffffff', '#eeeef0', '#e6e6e9', '#e1e1e5', '#c6c6cc', '#18181b', '#4f4f57', '#62626a', '#c2410c', '#a3360a', '#fcebe1', '#f9e1d4', '#23704a', '#e0f0e5', '#be123c', '#fce4e8', '#ffffff', '#18181b1f', '#18181b73'];
const dark = ['#141416', '#0e0e10', '#111113', '#1b1b1e', '#212125', '#29292d', '#29292e', '#3f3f46', '#ededef', '#b4b4bc', '#8f8f99', '#f07a3d', '#ff9a62', '#3a2216', '#40271a', '#86d19a', '#1a2e21', '#fb7c93', '#3a1d25', '#1a0c04', '#00000080', '#000000a6'];
function preset(id: string, name: string, mode: ThemeDefinition['mode'], overrides: Record<string, string> = {}): ThemeDefinition {
  // Lanes avoid orange so HEAD and selection (accent) stay distinct; lane 5 doubles as --amber.
  const lanes = mode === 'light' ? ['#2563a8', '#0f7a6e', '#6d4fc2', '#b42359', '#92660a', '#3f7d2a', '#0e7490', '#6b6b75'] : ['#6ea8f0', '#5cc7b5', '#b39cf5', '#f07ab0', '#e6c166', '#95d17e', '#5fc4dc', '#a8a8b3'];
  const base = mode === 'light' ? light : dark;
  return { id, name, mode, colors: { ...Object.fromEntries(COLOR_KEYS.map((key, i) => [key, [...base, ...lanes, base[11], lanes[2], base[11]][i]])), ...overrides } };
}
function family(id: string, name: string, mode: ThemeDefinition['mode'], bg: string, chrome: string, raised: string, text: string, secondary: string, accent: string, red: string, green: string): ThemeDefinition {
  const mix = (a: string, b: string, weight: number) => '#' + [1, 3, 5].map(i => Math.round(parseInt(a.slice(i, i + 2), 16) * weight + parseInt(b.slice(i, i + 2), 16) * (1 - weight)).toString(16).padStart(2, '0')).join('');
  return preset(id, name, mode, { bg, chrome, sidebar: chrome, raised, text, secondary, muted: secondary, accent, accentText: accent, subtle: mix(text, bg, .06), hover: mix(text, bg, .12), border: mix(text, bg, .18), borderStrong: mix(text, bg, .3), accentWash: mix(accent, bg, .14), selected: mix(accent, bg, .2), red, green, redWash: mix(red, bg, .13), greenWash: mix(green, bg, .13), buttonForeground: bg, graphLane1: accent, graphLane2: red, graphLane3: green, graphSelection: accent, graphHead: green });
}
export const BUILTIN_THEMES: ThemeDefinition[] = [
  preset('gitty-light', 'Gitty Light', 'light'), preset('gitty-dark', 'Gitty Dark', 'dark'),
  family('gruvbox-light', 'Gruvbox Light', 'light', '#fbf1c7', '#ebdbb2', '#f9f5d7', '#3c3836', '#665c54', '#076678', '#9d0006', '#427b58'),
  family('gruvbox-dark', 'Gruvbox Dark', 'dark', '#282828', '#1d2021', '#32302f', '#ebdbb2', '#bdae93', '#8ec07c', '#fb4934', '#b8bb26'),
  family('dracula', 'Dracula', 'dark', '#282a36', '#21222c', '#343746', '#f8f8f2', '#bfc2d5', '#bd93f9', '#ff5555', '#50fa7b'),
  family('nord', 'Nord', 'dark', '#2e3440', '#272d38', '#3b4252', '#eceff4', '#d8dee9', '#88c0d0', '#bf616a', '#a3be8c'),
  family('catppuccin-latte', 'Catppuccin Latte', 'light', '#eff1f5', '#e6e9ef', '#ffffff', '#4c4f69', '#5c5f77', '#8839ef', '#d20f39', '#40722f'),
  family('catppuccin-mocha', 'Catppuccin Mocha', 'dark', '#1e1e2e', '#181825', '#313244', '#cdd6f4', '#bac2de', '#cba6f7', '#f38ba8', '#a6e3a1'),
];
export const MAX_CUSTOM_THEMES = 30;
export const MAX_THEME_FILE_BYTES = 100_000;
export function isColor(value: unknown, alpha = false): value is string {
  return typeof value === 'string' && (alpha ? /^#[\da-f]{6}([\da-f]{2})?$/i : /^#[\da-f]{6}$/i).test(value);
}
export function validateTheme(value: unknown): ThemeDefinition {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Theme must be an object.');
  const t = value as ThemeDefinition;
  if (Object.keys(t).some(k => !['id', 'name', 'mode', 'colors'].includes(k)) || typeof t.id !== 'string' || !/^custom-[a-zA-Z0-9-]{1,80}$/.test(t.id) || typeof t.name !== 'string' || !t.name.trim() || t.name.length > 60 || /[\u0000-\u001f]/.test(t.name) || !['light', 'dark'].includes(t.mode)) throw new Error('Invalid custom theme identity, name, or mode.');
  if (!t.colors || Array.isArray(t.colors) || typeof t.colors !== 'object' || Object.keys(t.colors).length !== COLOR_KEYS.length || COLOR_KEYS.some(k => !Object.hasOwn(t.colors, k) || !isColor(t.colors[k], k === 'shadow' || k === 'backdrop'))) throw new Error('Theme must contain every supported color, no unknown colors, using #RRGGBB (shadow/backdrop may use #RRGGBBAA).');
  return { id: t.id, name: t.name.trim(), mode: t.mode, colors: { ...t.colors } };
}
export function importTheme(json: string): ThemeDefinition {
  if (new TextEncoder().encode(json).length > MAX_THEME_FILE_BYTES) throw new Error('Theme file is too large (100 KB maximum).');
  const data = JSON.parse(json);
  if (!data || data.version !== 1 || Object.keys(data).some(k => !['version', 'theme'].includes(k))) throw new Error('Unsupported theme file version.');
  return validateTheme(data.theme);
}
export function exportTheme(theme: ThemeDefinition): string { return JSON.stringify({ version: 1, theme: validateTheme(theme) }, null, 2); }
export function themeTokens(theme: ThemeDefinition): Record<string, string> {
  const tokens = Object.fromEntries(Object.entries(theme.colors).map(([key, color]) => [`--${key.replace(/[A-Z]/g, c => `-${c.toLowerCase()}`)}`, color]));
  tokens['--shadow-color'] = theme.colors.shadow;
  tokens['--shadow'] = `0 12px 40px ${theme.colors.shadow}`;
  return tokens;
}
export function contrastRatio(a: string, b: string): number {
  const luminance = (color: string) => {
    if (!isColor(color)) throw new Error('Contrast requires opaque hex colors.');
    const channels = [1, 3, 5].map(i => parseInt(color.slice(i, i + 2), 16) / 255).map(v => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4);
    return channels[0] * .2126 + channels[1] * .7152 + channels[2] * .0722;
  };
  const x = luminance(a), y = luminance(b);
  return (Math.max(x, y) + .05) / (Math.min(x, y) + .05);
}
