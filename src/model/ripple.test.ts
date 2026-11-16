// @vitest-environment jsdom
import { afterEach, expect, it } from 'vitest';
import { attachRipple } from './ripple';

afterEach(() => { document.body.innerHTML = ''; });

it('marks a pressed button with its pointer origin and clears it after the animation', () => {
  const off = attachRipple();
  document.body.innerHTML = '<button id="a"><span>x</span></button><button id="b" disabled>y</button>';
  const a = document.getElementById('a')!;
  a.firstElementChild!.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, clientX: 7, clientY: 9 }));
  expect(a.hasAttribute('data-ripple')).toBe(true);
  expect(a.style.getPropertyValue('--rx')).toBe('7px');
  a.dispatchEvent(Object.assign(new Event('animationend', { bubbles: true }), { animationName: 'm-ripple' }));
  expect(a.hasAttribute('data-ripple')).toBe(false);
  document.getElementById('b')!.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
  expect(document.getElementById('b')!.hasAttribute('data-ripple')).toBe(false);
  off();
});
