import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { backendPackage } from './backend-package.mjs';

test('selects current core or historical desktop benchmark package', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gitty-bench-package-'));
  try {
    const core = join(root, 'crates', 'gitty-core');
    const desktop = join(root, 'src-tauri');
    await mkdir(join(core, 'src'), { recursive: true });
    await mkdir(join(desktop, 'src'), { recursive: true });
    await writeFile(join(core, 'Cargo.toml'), '');
    await writeFile(join(core, 'src', 'bench_tests.rs'), '');
    await writeFile(join(desktop, 'Cargo.toml'), '');
    await writeFile(join(desktop, 'src', 'bench_tests.rs'), '');
    assert.equal(backendPackage(root).manifest, join(core, 'Cargo.toml'));
    await rm(core, { recursive: true });
    assert.equal(backendPackage(root).manifest, join(desktop, 'Cargo.toml'));
    await rm(desktop, { recursive: true });
    assert.throws(() => backendPackage(root), /No backend benchmark package/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
