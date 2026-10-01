import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';

// Pin both version and archive digest: release builds never execute an unverified download.
const version = '2.9.1';
const digests = {
  'osx-arm64': '2ac8f99258d04acb45cf592eb5b06ec0e0760c329bce40a4d18dabb5e0e37f68',
  'osx-x64': '326fc3e1c708ae792b010b2f9f701f3dc4dbaebdf40cafd036254ab0f148c034',
  'linux-arm64': 'cf3806b7528b5a5af16bd4bd0683202fc432d9008dd91d20c4c6744b24a033b5',
  'linux-x64': '31fc151c3b111ffe25616a4356bd9a50bdcdbd0922c5e11990fb220c6caf1ce1',
  'win-arm64': '1b573743a6162415d8398cbd9e2201aa8c43fd291bf45c242a5a12fa5ded3bd1',
  'win-x64': '7dea2afd3b9ea22109d25f95066025d70e57281d96062605304f89fcca41b535',
};
const target = process.env.TAURI_ENV_TARGET_TRIPLE;
const platform = target ? target.includes('windows') ? 'win' : target.includes('apple') ? 'osx' : target.includes('linux') ? 'linux' : ''
  : { darwin: 'osx', win32: 'win', linux: 'linux' }[process.platform];
const arch = target ? target.startsWith('aarch64') ? 'arm64' : target.startsWith('x86_64') ? 'x64' : '' : process.arch;
const key = `${platform}-${arch}`;
if (!digests[key]) throw new Error(`Unsupported GCM target: ${target || key}. Build each supported architecture separately.`);
const destination = resolve('src-tauri/resources/gcm');
const marker = `${version}-${key}`;
try {
  if (await readFile(join(destination, '.version'), 'utf8') === marker) process.exit(0);
} catch { /* first build */ }
const temporary = await mkdtemp(join(tmpdir(), 'gitty-gcm-'));
try {
  const extension = platform === 'win' ? 'zip' : 'tar.gz';
  const name = `gcm-${key}-${version}.${extension}`;
  const response = await fetch(`https://github.com/git-ecosystem/git-credential-manager/releases/download/v${version}/${name}`, { signal: AbortSignal.timeout(120_000) });
  if (!response.ok) throw new Error(`GCM download failed: HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (createHash('sha256').update(bytes).digest('hex') !== digests[key]) throw new Error('GCM archive checksum mismatch');
  const archive = join(temporary, name);
  const extracted = join(temporary, 'gcm');
  await writeFile(archive, bytes);
  await mkdir(extracted);
  // Windows tar (bsdtar) also extracts ZIP; keep the full portable distribution and its notices.
  execFileSync('tar', ['-xf', archive, '-C', extracted], { stdio: 'inherit' });
  await readFile(join(extracted, platform === 'win' ? 'git-credential-manager.exe' : 'git-credential-manager'));
  await writeFile(join(extracted, '.version'), marker);
  await writeFile(join(extracted, 'README.txt'), 'The portable Git Credential Manager distribution is prepared here by npm run prepare:gcm.\nGenerated binaries are ignored by Git. Desktop release builds prepare it automatically.\n');
  await mkdir(resolve('src-tauri/resources'), { recursive: true });
  await rm(destination, { recursive: true, force: true });
  await cp(extracted, destination, { recursive: true });
  console.log(`Prepared Git Credential Manager ${marker}`);
} finally {
  await rm(temporary, { recursive: true, force: true });
}
