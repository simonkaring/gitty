export type DesignFamily = 'default' | 'material' | 'apple';
export interface ThemeDefinition {
  id: string;
  name: string;
  mode: 'light' | 'dark';
  design?: DesignFamily;
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
  {
    id: 'material-google-dark',
    name: 'Material Google Dark',
    mode: 'dark',
    design: 'material',
    colors: {
      bg: '#1a1c25', chrome: '#0c0d12', sidebar: '#15171e', raised: '#232630', subtle: '#2d303b', hover: '#373a45', border: '#3f424d', borderStrong: '#767a87', text: '#e6e7ef', secondary: '#c0c3d1', muted: '#a7aab8', accent: '#aab9fc', accentText: '#aab9fc', accentWash: '#262c47', selected: '#383e58', green: '#81c995', greenWash: '#213c27', red: '#f28b82', redWash: '#4f2825', buttonForeground: '#1f2557', shadow: '#00000099', backdrop: '#00000080', graphLane1: '#8ab4f8', graphLane2: '#f28b82', graphLane3: '#81c995', graphLane4: '#fdd663', graphLane5: '#d7aefb', graphLane6: '#78d9ec', graphLane7: '#fcad70', graphLane8: '#ff8bcb', graphSelection: '#aab9fc', graphMerge: '#fdd663', graphHead: '#e6e7ef',
    },
  },
  {
    id: 'material-google-light',
    name: 'Material Google Light',
    mode: 'light',
    design: 'material',
    colors: {
      bg: '#eef0f8', chrome: '#f9fafe', sidebar: '#f4f5fc', raised: '#e7e9f2', subtle: '#e0e2ed', hover: '#d7dae6', border: '#c1c4ce', borderStrong: '#717481', text: '#191a20', secondary: '#444753', muted: '#575a66', accent: '#444dbd', accentText: '#444dbd', accentWash: '#e1e7fe', selected: '#d4ddfd', green: '#146c2e', greenWash: '#c4eed0', red: '#b3261e', redWash: '#f9dedc', buttonForeground: '#ffffff', shadow: '#00000040', backdrop: '#00000052', graphLane1: '#1a73e8', graphLane2: '#d93025', graphLane3: '#188038', graphLane4: '#b06000', graphLane5: '#9334e6', graphLane6: '#129eaf', graphLane7: '#e8710a', graphLane8: '#c2185b', graphSelection: '#444dbd', graphMerge: '#b06000', graphHead: '#191a20',
    },
  },
];
// Apple: macOS/iOS system palette. Surfaces, separators and washes are the reference's
// translucent values flattened onto their base; accent/green/red text are darkened or
// lightened to reach WCAG AA on washes and selection.
const apple = (mode: 'light' | 'dark', colors: Record<string, string>): ThemeDefinition => ({ id: `apple-${mode}`, name: mode === 'dark' ? 'Apple Dark' : 'Apple', mode, design: 'apple', colors } as ThemeDefinition);
BUILTIN_THEMES.push(
  apple('light', {
    bg: '#ffffff', chrome: '#f2f2f7', sidebar: '#f1f1f5', raised: '#ffffff', subtle: '#f4f4f4', hover: '#ebebeb', border: '#e6e6e6', borderStrong: '#bbbbbc',
    text: '#1d1d1f', secondary: '#696970', muted: '#5e5e63', accent: '#007aff', accentText: '#00438c', accentWash: '#e0efff', selected: '#c2dfff',
    green: '#187a34', greenWash: '#e3f7e8', red: '#d70015', redWash: '#ffe7e6', buttonForeground: '#ffffff', shadow: '#0000002e', backdrop: '#00000052',
    graphLane1: '#007aff', graphLane2: '#af52de', graphLane3: '#ff2d55', graphLane4: '#ff9500', graphLane5: '#34c759', graphLane6: '#30b0c7', graphLane7: '#5856d6', graphLane8: '#6d6d72',
    graphSelection: '#007aff', graphMerge: '#ff9500', graphHead: '#007aff',
  }),
  apple('dark', {
    bg: '#1c1c1e', chrome: '#141416', sidebar: '#262628', raised: '#202023', subtle: '#2b2b2d', hover: '#38383a', border: '#333335', borderStrong: '#5d5d5f',
    text: '#f5f5f7', secondary: '#c7c7cc', muted: '#a1a1a6', accent: '#0a84ff', accentText: '#57abff', accentWash: '#192f47', selected: '#163d66',
    green: '#3ddb64', greenWash: '#1f3526', red: '#ff7a70', redWash: '#3e2222', buttonForeground: '#ffffff', shadow: '#00000080', backdrop: '#000000a6',
    graphLane1: '#0a84ff', graphLane2: '#bf5af2', graphLane3: '#ff375f', graphLane4: '#ff9f0a', graphLane5: '#30d158', graphLane6: '#40c8e0', graphLane7: '#5e5ce6', graphLane8: '#a8a8b3',
    graphSelection: '#0a84ff', graphMerge: '#ff9f0a', graphHead: '#0a84ff',
  }),
);
export const MAX_CUSTOM_THEMES = 30;
export const MAX_THEME_FILE_BYTES = 100_000;
export function isColor(value: unknown, alpha = false): value is string {
  return typeof value === 'string' && (alpha ? /^#[\da-f]{6}([\da-f]{2})?$/i : /^#[\da-f]{6}$/i).test(value);
}
export function validateTheme(value: unknown): ThemeDefinition {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Theme must be an object.');
  const t = value as ThemeDefinition;
  if (Object.keys(t).some(k => !['id', 'name', 'mode', 'design', 'colors'].includes(k)) || typeof t.id !== 'string' || !/^custom-[a-zA-Z0-9-]{1,80}$/.test(t.id) || typeof t.name !== 'string' || !t.name.trim() || t.name.length > 60 || /[\u0000-\u001f]/.test(t.name) || !['light', 'dark'].includes(t.mode) || (t.design !== undefined && !['default', 'material', 'apple'].includes(t.design as string))) throw new Error('Invalid custom theme identity, name, mode, or design family.');
  if (!t.colors || Array.isArray(t.colors) || typeof t.colors !== 'object' || Object.keys(t.colors).length !== COLOR_KEYS.length || COLOR_KEYS.some(k => !Object.hasOwn(t.colors, k) || !isColor(t.colors[k], k === 'shadow' || k === 'backdrop'))) throw new Error('Theme must contain every supported color, no unknown colors, using #RRGGBB (shadow/backdrop may use #RRGGBBAA).');
  return { id: t.id, name: t.name.trim(), mode: t.mode, ...(t.design ? { design: t.design } : {}), colors: { ...t.colors } };
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
