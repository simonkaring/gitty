import { describe, expect, it } from 'vitest';
import { AVATAR_SHAPES, shapeOf } from './shape';

describe('shapeOf', () => {
  it('is stable per author and spreads the demo authors over every shape', () => {
    expect(shapeOf('Alex Morgan')).toBe(shapeOf('Alex Morgan'));
    const used = new Set(['Alex Morgan', 'Jamie Chen', 'Jordan Lee', 'Sam Rivera', 'Taylor Kim'].map(shapeOf));
    expect([...used].sort()).toEqual([...AVATAR_SHAPES].sort());
  });
});
