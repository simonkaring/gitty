import { COLOR_KEYS } from './themes';

type Mode = 'light' | 'dark';
const gamma = (x: number) => (x <= 0.0031308 ? 12.92 * x : 1.055 * x ** (1 / 2.4) - 0.055);
const linear = (x: number) => (x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4);

function oklchToRgb(L: number, C: number, h: number): number[] {
  const a = C * Math.cos(h * Math.PI / 180), b = C * Math.sin(h * Math.PI / 180);
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3, m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3, s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s, -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s, -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s];
}

/** Hue (degrees) and chroma of a #RRGGBB seed in OKLCH. */
function seedOf(hex: string): { hue: number; chroma: number } {
  const [r, g, b] = [1, 3, 5].map(i => linear(parseInt(hex.slice(i, i + 2), 16) / 255));
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b), m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b), s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  const a = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s, c = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  return { hue: (Math.atan2(c, a) * 180 / Math.PI + 360) % 360, chroma: Math.hypot(a, c) };
}

/** Color at a Material-style tone (0 black, 100 white), shrinking chroma until it fits sRGB. */
function tone(t: number, hue: number, chroma: number): string {
  return lightness(t >= 100 ? 1 : t <= 0 ? 0 : t > 8 ? (t + 16) / 116 : Math.cbrt(t / 903.3), hue, chroma);
}

/** Color at an OKLCH lightness, shrinking chroma until it fits sRGB. */
function lightness(L: number, hue: number, chroma: number): string {
  let rgb = oklchToRgb(L, chroma, hue);
  for (let i = 0; i < 40 && rgb.some(v => v < -0.0005 || v > 1.0005); i++) rgb = oklchToRgb(L, chroma *= 0.92, hue);
  return '#' + rgb.map(v => Math.round(Math.min(1, Math.max(0, gamma(Math.max(0, v)))) * 255).toString(16).padStart(2, '0')).join('');
}

/** Material 3 style tonal palette for a seed color, mapped onto every Gitty theme color. */
export function materialColors(seed: string, mode: Mode): Record<string, string> {
  const { hue, chroma } = seedOf(seed);
  const P = Math.min(0.2, Math.max(chroma, 0.12));
  const d = mode === 'dark';
  const N = (t: number) => tone(t, hue, 0.006);
  // Surfaces are hue-tinted tonal containers: chrome < sidebar/inspector < main pane < raised < subtle < hover.
  const S = (L: number, c: number) => lightness(L, hue, c);
  const lane = (i: number) => tone(d ? 78 : 42, hue + i * 45, 0.13);
  const values: Record<string, string> = d ? {
    chrome: S(0.16, 0.012), sidebar: S(0.205, 0.015), bg: S(0.23, 0.017), raised: S(0.27, 0.019), subtle: S(0.31, 0.02), hover: S(0.35, 0.02), border: S(0.38, 0.02), borderStrong: S(0.58, 0.02),
    text: S(0.93, 0.01), secondary: S(0.82, 0.02), muted: S(0.74, 0.02),
    accent: lightness(0.8, hue, P), accentText: lightness(0.8, hue, P), accentWash: lightness(0.3, hue, 0.05), selected: lightness(0.37, hue, 0.045), green: tone(80, 150, 0.15), greenWash: tone(22, 150, 0.05), red: tone(85, 25, 0.12), redWash: tone(22, 25, 0.06),
    buttonForeground: lightness(0.29, hue, 0.09), shadow: '#00000099', backdrop: '#00000080', graphSelection: lightness(0.8, hue, P), graphMerge: tone(85, 95, 0.14), graphHead: S(0.93, 0.01),
  } : {
    chrome: S(0.985, 0.006), sidebar: S(0.972, 0.009), bg: S(0.955, 0.011), raised: S(0.935, 0.013), subtle: S(0.915, 0.015), hover: S(0.89, 0.016), border: S(0.82, 0.015), borderStrong: S(0.56, 0.02),
    text: S(0.22, 0.012), secondary: S(0.4, 0.02), muted: S(0.47, 0.02),
    accent: lightness(0.48, hue, P), accentText: lightness(0.48, hue, P), accentWash: lightness(0.93, hue, 0.035), selected: lightness(0.9, hue, 0.05), green: tone(35, 150, 0.12), greenWash: tone(90, 150, 0.06), red: tone(40, 25, 0.16), redWash: tone(92, 25, 0.05),
    buttonForeground: N(100), shadow: '#00000040', backdrop: '#00000052', graphSelection: lightness(0.48, hue, P), graphMerge: tone(45, 70, 0.12), graphHead: S(0.22, 0.012),
  };
  for (let i = 0; i < 8; i++) values[`graphLane${i + 1}`] = lane(i);
  return Object.fromEntries(COLOR_KEYS.map(key => [key, values[key]]));
}
