import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export function binaryName(target) {
  if (!/^[a-z0-9_]+-[a-z0-9_]+-[a-z0-9_]+(?:-[a-z0-9_]+)*$/i.test(target)) {
    throw new Error(`Invalid Rust target triple: ${target}`);
  }
  return `gitty-cli${target.includes('windows') ? '.exe' : ''}`;
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'], ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} exited with status ${result.status}`);
  return result.stdout.trim();
}

export function argsFrom(argv) {
  let target;
  let outDir = 'src-tauri/target/cli-artifacts';
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--target' && !target && argv[i + 1]) target = argv[++i];
    else if (argv[i] === '--out-dir' && argv[i + 1]) outDir = argv[++i];
    else throw new Error(`Unknown or incomplete argument: ${argv[i]}`);
  }
  return { target, outDir };
}

export async function packageCli({ target, outDir = 'src-tauri/target/cli-artifacts' }) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const manifest = join(root, 'crates', 'gitty-cli', 'Cargo.toml');
  if (target) binaryName(target);
  const host = run('rustc', ['-vV']).match(/^host: (.+)$/m)?.[1];
  if (!host) throw new Error('Could not determine Rust host target');
  target ||= host;
  const name = binaryName(target);

  const cargo = JSON.parse(run('cargo', ['metadata', '--no-deps', '--format-version', '1', '--manifest-path', manifest], { cwd: root }));
  const version = cargo.packages.find((pkg) => pkg.manifest_path === manifest)?.version;
  if (!version) throw new Error('Could not find gitty-cli version in Cargo metadata');
  run('cargo', ['build', '--manifest-path', manifest, '--release', '--target', target], { cwd: root });
  const built = join(cargo.target_directory, target, 'release', name);
  const bytes = await readFile(built);
  const outputDir = resolve(root, outDir);
  await mkdir(outputDir, { recursive: true });
  const outputBinary = join(outputDir, binaryName(target));
  await copyFile(built, outputBinary);

  if (target === host) {
    JSON.parse(run(outputBinary, ['doctor', '--json']));
    JSON.parse(run(outputBinary, ['capabilities', '--json']));
  }
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  await writeFile(join(outputDir, `${basename(outputBinary)}.manifest.json`), `${JSON.stringify({ version, target, binary: basename(outputBinary), sha256 }, null, 2)}\n`);
  console.log(`Packaged ${outputBinary} (${target}, sha256 ${sha256})`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  packageCli(argsFrom(process.argv.slice(2))).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
