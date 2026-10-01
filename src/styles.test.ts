import { readFileSync } from 'node:fs';
import postcss from 'postcss';
import { describe, expect, it } from 'vitest';

/** Guards visual cohesion: spacing on one scale, type and radii only via tokens. */
const root = postcss.parse(readFileSync(new URL('./styles.css', import.meta.url), 'utf8'));
const SPACE = new Set([0, 1, 2, 4, 6, 8, 12, 16, 20, 24, 32]);
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
