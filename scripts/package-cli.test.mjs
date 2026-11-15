import test from 'node:test';
import assert from 'node:assert/strict';
import { argsFrom, binaryName } from './package-cli.mjs';

test('selects platform binary name from Rust target', () => {
  assert.equal(binaryName('x86_64-pc-windows-msvc'), 'gitty-cli.exe');
  assert.equal(binaryName('aarch64-apple-darwin'), 'gitty-cli');
  assert.equal(binaryName('x86_64-unknown-linux-gnu'), 'gitty-cli');
  assert.throws(() => binaryName('../unsafe'), /Invalid Rust target/);
});

test('parses packaging defaults and explicit target/output options', () => {
  assert.deepEqual(argsFrom([]), { target: undefined, outDir: 'src-tauri/target/cli-artifacts' });
  assert.deepEqual(argsFrom(['--target', 'aarch64-apple-darwin', '--out-dir', 'artifacts']), {
    target: 'aarch64-apple-darwin',
    outDir: 'artifacts',
  });
  assert.throws(() => argsFrom(['--target']), /Unknown or incomplete argument/);
  assert.throws(() => argsFrom(['--target', 'one', '--target', 'two']), /Unknown or incomplete argument/);
});
