import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { diffRows } from '../../src/model/splitDiff.ts';

// Optional positional arguments are other revisions of splitDiff.ts. Rotate
// their batch order within one process to reduce sensitivity to machine load.
const variants = [{ name: 'working', run: diffRows }];
for (const file of process.argv.slice(2)) variants.push({ name: file, run: (await import(pathToFileURL(resolve(file)))).diffRows });

// Time just the initial split row model, before React renders the first window.
for (const [shape, pattern] of Object.entries({
  sparse: [...Array(98).fill('context'), 'remove', 'add'],
  replacement: [...Array(48).fill('remove'), ...Array(50).fill('add'), 'meta', 'context'],
})) {
  const hunks = Array.from({ length: 20 }, (_, h) => ({
    header: `@@ hunk ${h} @@`,
    lines: Array.from({ length: 1000 }, (_, i) => {
      const kind = pattern[i % pattern.length], n = h * 1000 + i + 1;
      return { kind, oldLine: ['remove', 'context'].includes(kind) ? n : null, newLine: ['add', 'context'].includes(kind) ? n : null, content: `line ${n}` };
    }),
  }));
  const expected = diffRows(hunks, true);
  const digest = createHash('sha256').update(JSON.stringify(expected)).digest('hex');
  const samples = variants.map(() => []);
  for (const { run } of variants) assert.deepEqual(run(hunks, true), expected);
  for (let batch = 0; batch < 12; batch++) {
    for (let slot = 0; slot < variants.length; slot++) {
      const v = (batch + slot) % variants.length;
      const run = variants[v].run;
      const start = performance.now();
      let length = 0;
      for (let i = 0; i < 40; i++) length += run(hunks, true).length;
      const elapsed = (performance.now() - start) / 40;
      assert.equal(length, 40 * expected.length);
      if (batch >= 3) samples[v].push(elapsed);
    }
  }
  for (const [v, { name }] of variants.entries()) console.log(JSON.stringify({ shape, name, digest, rows: expected.length, unit: 'ms/model', median: samples[v].toSorted((a, b) => a - b)[4], samples: samples[v] }));
}
