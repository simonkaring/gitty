// Generates the repositories used by the backend and app benchmarks.
//
//   node scripts/bench/fixtures.mjs [--dir <path>] [--real] [--force]
//
// Synthetic repositories are written with `git fast-import`, so they are
// deterministic and need no network. `--real` also clones git/git (about
// 80,000 commits and 900 tags; roughly 300 MB of network and disk).
// Every fixture's `origin` points back at the repository itself and fetches
// only its default branch, so an app's automatic fetch completes locally and
// changes nothing while a benchmark is watching the window.
import { execFileSync, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { benchDir, parseArgs } from './common.mjs';

const args = parseArgs(process.argv.slice(2));
const root = join(args.dir ?? benchDir(), 'repos');

const git = (cwd, ...argv) => execFileSync('git', argv, { cwd, encoding: 'utf8', maxBuffer: 1 << 28 }).trim();

/** Writes commits on `main`, short-lived feature branches merged back every
 * `mergeEvery` commits, extra unmerged branches and lightweight tags. */
function fastImport(dir, { commits, files, mergeEvery = 0, openBranches = 0, tags = 0, initialFiles = 0 }) {
  return new Promise((resolve, reject) => {
    const child = spawn('git', ['fast-import', '--quiet', '--done'], { cwd: dir, stdio: ['pipe', 'inherit', 'inherit'] });
    child.on('error', reject);
    child.on('exit', code => code === 0 ? resolve() : reject(new Error(`fast-import exited with ${code}`)));
    let mark = 0;
    let time = 1_600_000_000;
    let chunk = [];
    const flush = () => new Promise(done => {
      const text = chunk.join('');
      chunk = [];
      if (child.stdin.write(text)) done(); else child.stdin.once('drain', done);
    });
    const data = text => `data ${Buffer.byteLength(text)}\n${text}\n`;
    const commit = (ref, message, parents, changes) => {
      mark += 1;
      time += 60;
      const who = `Bench Author ${mark % 17} <author${mark % 17}@example.com> ${time} +0000\n`;
      chunk.push(`commit ${ref}\nmark :${mark}\nauthor ${who}committer ${who}${data(message)}`);
      if (parents[0]) chunk.push(`from :${parents[0]}\n`);
      for (const parent of parents.slice(1)) chunk.push(`merge :${parent}\n`);
      for (const [path, content] of changes) chunk.push(`M 100644 inline ${path}\n${data(content)}`);
      chunk.push('\n');
      return mark;
    };
    const path = n => `src/module-${Math.floor(n / 100) % 100}/file-${n % files}.txt`;
    (async () => {
      const initial = [['README.md', '# Benchmark fixture\n']];
      for (let n = 0; n < initialFiles; n++) initial.push([`tree/dir-${Math.floor(n / 200)}/file-${n}.txt`, `initial content ${n}\nline two\nline three\n`]);
      let tip = commit('refs/heads/main', 'Initial commit\n', [], initial);
      let made = 1;
      let branch = 0;
      while (made < commits) {
        if (mergeEvery && made % mergeEvery === 0 && made + 4 < commits) {
          branch += 1;
          let side = tip;
          for (let i = 0; i < 2; i++) side = commit(`refs/heads/topic/${branch}`, `Topic ${branch} change ${i}\n\nDetails for topic ${branch}.\n`, [side], [[path(made + i * 7), `topic ${branch} ${i}\n`]]);
          tip = commit('refs/heads/main', `Second change ${made}\n`, [tip], [[path(made + 3), `main ${made}\n`]]);
          tip = commit('refs/heads/main', `Merge branch 'topic/${branch}'\n`, [tip, side], []);
          chunk.push(`reset refs/heads/topic/${branch}\nfrom 0000000000000000000000000000000000000000\n\n`);
          made += 4;
        } else {
          tip = commit('refs/heads/main', `Change ${made}: update ${path(made)}\n\nBody line for commit ${made}.\n`, [tip], [[path(made), `content ${made}\n`.repeat(1 + (made % 5))]]);
          made += 1;
        }
        if (made % (Math.max(1, Math.floor(commits / Math.max(1, tags)))) === 0 && tags) chunk.push(`reset refs/tags/v${made}\nfrom :${tip}\n\n`);
        if (chunk.length > 5000) await flush();
      }
      // Unmerged branches spread over history give the graph many lanes and refs.
      for (let b = 0; b < openBranches; b++) {
        const base = Math.max(1, mark - Math.floor((b + 1) * (mark / (openBranches + 1))));
        commit(`refs/heads/feature/${b}`, `Feature ${b} work\n`, [base], [[`feature/${b}.txt`, `feature ${b}\n`]]);
        if (chunk.length > 5000) await flush();
      }
      chunk.push('done\n');
      await flush();
      child.stdin.end();
    })().catch(reject);
  });
}

function selfOrigin(dir, branch) {
  git(dir, 'remote', 'add', 'origin', `file://${dir}`);
  git(dir, 'config', 'remote.origin.fetch', `+refs/heads/${branch}:refs/remotes/origin/${branch}`);
  git(dir, 'config', 'remote.origin.tagOpt', '--no-tags');
  git(dir, 'update-ref', `refs/remotes/origin/${branch}`, branch);
  git(dir, 'branch', `--set-upstream-to=origin/${branch}`, branch);
}

async function synthetic(name, options, after) {
  const dir = join(root, name);
  if (existsSync(dir) && !args.force) return console.log(`= ${name} (exists)`);
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  const started = Date.now();
  git(dir, 'init', '--quiet', '-b', 'main');
  git(dir, 'config', 'user.name', 'Bench');
  git(dir, 'config', 'user.email', 'bench@example.com');
  git(dir, 'config', 'gc.auto', '0');
  await fastImport(dir, options);
  git(dir, 'checkout', '--quiet', '-f', 'main');
  selfOrigin(dir, 'main');
  if (after) await after(dir);
  console.log(`+ ${name}: ${git(dir, 'rev-list', '--count', '--all')} commits, ${git(dir, 'for-each-ref').split('\n').length} refs (${((Date.now() - started) / 1000).toFixed(1)} s)`);
}

await mkdir(root, { recursive: true });
await synthetic('small', { commits: 2_000, files: 200, mergeEvery: 50, openBranches: 10, tags: 20 });
await synthetic('large-history', { commits: 100_000, files: 5_000, mergeEvery: 25, openBranches: 300, tags: 300 });
await synthetic('wide-status', { commits: 1_000, files: 500, initialFiles: 20_000 }, async dir => {
  // 5,000 modified tracked files and 5,000 untracked files: 10,000 working entries.
  for (let n = 0; n < 20_000; n += 4) {
    const file = join(dir, `tree/dir-${Math.floor(n / 200)}/file-${n}.txt`);
    await writeFile(file, `modified content ${n}\nline two\nline three changed\n`);
  }
  for (let n = 0; n < 5_000; n++) {
    if (n % 500 === 0) await mkdir(join(dir, `untracked/dir-${n / 500}`), { recursive: true });
    await writeFile(join(dir, `untracked/dir-${Math.floor(n / 500)}/new-${n}.txt`), `untracked ${n}\n`);
  }
});

if (args.real) {
  const dir = join(root, 'git-git');
  if (existsSync(dir) && !args.force) console.log('= git-git (exists)');
  else {
    await rm(dir, { recursive: true, force: true });
    console.log('Cloning https://github.com/git/git.git …');
    execFileSync('git', ['clone', '--quiet', 'https://github.com/git/git.git', dir], { stdio: 'inherit' });
  }
  // Point origin at the clone itself, as for the synthetic fixtures.
  const branch = git(dir, 'symbolic-ref', '--short', 'HEAD');
  git(dir, 'remote', 'set-url', 'origin', `file://${dir}`);
  git(dir, 'config', 'remote.origin.fetch', `+refs/heads/${branch}:refs/remotes/origin/${branch}`);
  git(dir, 'config', 'gc.auto', '0');
  console.log(`+ git-git: ${git(dir, 'rev-list', '--count', '--all')} commits, ${git(dir, 'for-each-ref').split('\n').length} refs`);
}
console.log(`Fixtures in ${root}`);
