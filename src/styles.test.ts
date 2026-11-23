import { readdirSync, readFileSync } from 'node:fs';
import postcss from 'postcss';
import { describe, expect, it } from 'vitest';
import { COLOR_KEYS } from './model/themes';

/** Guards visual cohesion: spacing on one scale, type and radii only via tokens. */
const SHEETS = ['tokens', 'shell', 'history', 'inspector', 'working', 'feedback', 'motion', 'overrides'];
const root = postcss.parse(SHEETS.map(name => readFileSync(new URL(`./styles/${name}.css`, import.meta.url), 'utf8')).join('\n'));
const SPACE = new Set([0, 1, 2, 4, 6, 8, 12, 16, 20, 24, 32]);
/** Set inline on every history row by HistoryGraph, so the row styles read it without a fallback. */
const INLINE_PROPERTIES = new Set(['--branch-color']);
const offenders = (test: (prop: string, value: string) => boolean) => {
  const found: string[] = [];
  root.walkDecls(decl => { if (decl.parent?.type === 'rule' && (decl.parent as postcss.Rule).selector !== ':root' && test(decl.prop, decl.value)) found.push(`${(decl.parent as postcss.Rule).selector} { ${decl.prop}: ${decl.value} }`); });
  return found;
};

describe('styles.css design tokens', () => {
  it('uses the spacing scale for padding, margin and gap', () => {
    expect(offenders((prop, value) => /^(padding|margin|gap|row-gap|column-gap)/.test(prop) && [...value.matchAll(/-?(\d+(?:\.\d+)?)px/g)].some(([, px]) => Number(px) < 40 && !SPACE.has(Number(px))))).toEqual([]);
  });
  it('uses font-size tokens', () => {
    expect(offenders((prop, value) => prop === 'font-size' && /\dpx/.test(value) && !value.startsWith('clamp'))).toEqual([]);
  });
  it('uses radius tokens', () => {
    expect(offenders((prop, value) => /radius/.test(prop) && /\dpx/.test(value))).toEqual([]);
  });
  it('sizes every Dialog `size` the components pass', () => {
    const components = new URL('./components/', import.meta.url);
    const sizes = new Set(readdirSync(components).filter(name => name.endsWith('.tsx') && !name.includes('.test.')).flatMap(name => [...readFileSync(new URL(name, components), 'utf8').matchAll(/<Dialog\b[^>]*?\bsize="(\w+)"/g)].map(match => match[1])));
    const sized = new Set<string>();
    root.walkRules(/^\.dialog-\w+$/, rule => { if (rule.some(node => node.type === 'decl' && node.prop === 'width')) sized.add(rule.selector.slice('.dialog-'.length)); });
    expect(sizes.size).toBeGreaterThan(0);
    // `md` is the unmodified .dialog width.
    expect([...sizes].filter(size => size !== 'md' && !sized.has(size))).toEqual([]);
  });
  it('reads only custom properties that something defines', () => {
    const everything = postcss.parse([...SHEETS, 'material', 'apple'].map(name => readFileSync(new URL(`./styles/${name}.css`, import.meta.url), 'utf8')).join('\n'));
    const defined = new Set(COLOR_KEYS.map(key => `--${key.replace(/[A-Z]/g, c => `-${c.toLowerCase()}`)}`));
    everything.walkDecls(/^--/, decl => { defined.add(decl.prop); });
    everything.walkAtRules('property', rule => { defined.add(rule.params); });
    const undefinedReads = new Set<string>();
    // A read with a fallback is deliberate: those are set inline by components.
    everything.walkDecls(decl => { for (const [, name, fallback] of decl.value.matchAll(/var\(\s*(--[\w-]+)\s*(,)?/g)) if (!fallback && !defined.has(name)) undefinedReads.add(name); });
    expect([...undefinedReads].filter(name => !INLINE_PROPERTIES.has(name))).toEqual([]);
  });
  it('does not define a selector twice in the same context', () => {
    const seen = new Set<string>(); const dupes: string[] = [];
    root.walkRules(rule => {
      if (rule.parent?.type === 'atrule' && /keyframes/.test((rule.parent as postcss.AtRule).name)) return;
      const key = `${rule.parent?.type === 'atrule' ? (rule.parent as postcss.AtRule).params : ''}|${rule.selector}`;
      if (seen.has(key)) dupes.push(key); seen.add(key);
    });
    expect(dupes).toEqual([]);
  });
});
