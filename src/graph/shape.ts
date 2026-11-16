export const AVATAR_SHAPES = ['circle', 'cookie', 'squircle', 'diamond'] as const;
export type AvatarShape = (typeof AVATAR_SHAPES)[number];

/** Stable shape per author so a person is recognisable down the graph. */
export function shapeOf(author: string): AvatarShape {
  let hash = 5381;
  for (const char of author) hash = (Math.imul(hash, 33) + char.charCodeAt(0)) >>> 0;
  return AVATAR_SHAPES[(hash >>> 3) % AVATAR_SHAPES.length];
}

/** Traces a shape of radius `r` around (x, y); matches the CSS clip-paths in material.css. */
export function traceShape(ctx: CanvasRenderingContext2D, shape: AvatarShape, x: number, y: number, r: number, lobe = 0.09) {
  ctx.beginPath();
  if (shape === 'squircle') ctx.roundRect(x - r, y - r, 2 * r, 2 * r, r * 0.5);
  else if (shape === 'diamond') {
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(Math.PI / 4);
    const side = r * 1.55;
    ctx.roundRect(-side / 2, -side / 2, side, side, side * 0.3);
    ctx.restore();
  } else if (shape === 'cookie') {
    for (let i = 0; i <= 72; i++) {
      const t = (i / 72) * Math.PI * 2, rr = r * (1.02 - lobe + lobe * Math.cos(8 * t)) / 1.02;
      if (i) ctx.lineTo(x + rr * Math.cos(t), y + rr * Math.sin(t)); else ctx.moveTo(x + rr * Math.cos(t), y + rr * Math.sin(t));
    }
    ctx.closePath();
  } else ctx.arc(x, y, r, 0, Math.PI * 2);
}
