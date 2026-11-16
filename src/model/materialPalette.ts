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
  const L = t >= 100 ? 1 : t <= 0 ? 0 : t > 8 ? (t + 16) / 116 : Math.cbrt(t / 903.3);
  let rgb = oklchToRgb(L, chroma, hue);
  for (let i = 0; i < 40 && rgb.some(v => v < -0.0005 || v > 1.0005); i++) rgb = oklchToRgb(L, chroma *= 0.92, hue);
  return '#' + rgb.map(v => Math.round(Math.min(1, Math.max(0, gamma(Math.max(0, v)))) * 255).toString(16).padStart(2, '0')).join('');
}

/** Material 3 style tonal palette for a seed color, mapped onto every Gitty theme color. */
export function materialColors(seed: string, mode: Mode): Record<string, string> {
  const { hue, chroma } = seedOf(seed);
  const P = Math.min(0.2, Math.max(chroma, 0.12));
  const d = mode === 'dark';
  const N = (t: number) => tone(t, hue, 0.006), V = (t: number) => tone(t, hue, 0.012), A = (t: number, c = P) => tone(t, hue, c);
  const lane = (i: number) => tone(d ? 78 : 42, hue + i * 45, 0.13);
  const values: Record<string, string> = d ? {
    bg: N(12), chrome: N(6), sidebar: N(6), raised: N(17), subtle: N(22), hover: N(26), border: V(30), borderStrong: V(60), text: N(90), secondary: V(80), muted: V(70),
    accent: A(80), accentText: A(80), accentWash: A(25, 0.06), selected: A(32, 0.09), green: tone(80, 150, 0.15), greenWash: tone(22, 150, 0.05), red: tone(85, 25, 0.12), redWash: tone(22, 25, 0.06),
    buttonForeground: A(20), shadow: '#00000099', backdrop: '#00000080', graphSelection: A(80), graphMerge: tone(85, 95, 0.14), graphHead: tone(80, 150, 0.15),
  } : {
    bg: N(100), chrome: N(97), sidebar: N(97), raised: N(94), subtle: N(92), hover: N(88), border: V(80), borderStrong: V(50), text: N(10), secondary: V(30), muted: V(40),
    accent: A(40), accentText: A(40), accentWash: A(90, 0.05), selected: A(86, 0.07), green: tone(35, 150, 0.12), greenWash: tone(90, 150, 0.06), red: tone(40, 25, 0.16), redWash: tone(92, 25, 0.05),
    buttonForeground: N(100), shadow: '#00000040', backdrop: '#00000052', graphSelection: A(40), graphMerge: tone(45, 70, 0.12), graphHead: tone(35, 150, 0.12),
  };
  for (let i = 0; i < 8; i++) values[`graphLane${i + 1}`] = lane(i);
  return Object.fromEntries(COLOR_KEYS.map(key => [key, values[key]]));
}
