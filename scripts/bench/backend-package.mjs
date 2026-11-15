import { existsSync } from 'node:fs';
import { join } from 'node:path';

export function backendPackage(root) {
  const core = {
    manifest: join(root, 'crates', 'gitty-core', 'Cargo.toml'),
    test: join(root, 'crates', 'gitty-core', 'src', 'bench_tests.rs'),
  };
  if (existsSync(core.manifest) && existsSync(core.test)) return core;

  const desktop = {
    manifest: join(root, 'src-tauri', 'Cargo.toml'),
    test: join(root, 'src-tauri', 'src', 'bench_tests.rs'),
  };
  if (existsSync(desktop.manifest) && existsSync(desktop.test)) return desktop;
  throw new Error(`No backend benchmark package found in ${root}`);
}
