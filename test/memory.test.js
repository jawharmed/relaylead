// The project memory: `relaylead memory show|write`, its lock, archive, git exclusion and ceiling,
// the check of doctor, and the questions of init.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { run } = require('../core/cli');
const { home, missionDir } = require('../core/paths');
const { writeMemory: write, readMemory, memoryFile, archiveDir, projectRoot } = require('../core/memory');
const { writeJson } = require('../core/store');
const { gitRepo } = require('../fixtures/git');
const { installEnv, runRelaylead } = require('../fixtures/install-env');
const { makeIo, tmpDir } = require('../fixtures/helpers');
const { excludeRelaylead } = require('../deliveries/local-merge');
const { runFileSync } = require('../core/run-file');
const { freshHome, writeMission } = require('../fixtures/missions');

async function relaylead(args, env = { RELAYLEAD_MISSION: 'demo' }) {
  const io = makeIo({ env });
  const code = await run(args, io);
  return { code, out: io.out.text, err: io.err.text };
}

function project(t, config) {
  freshHome(t);
  const dir = gitRepo({ 'README.md': 'toy\n' });
  if (config) writeJson(path.join(dir, '.relaylead.json'), config);
  writeMission('demo', dir);
  return dir;
}

// Writes like a lead that has just read the memory: with its fingerprint.
const writeMemory = (mission, text, dir) => write(mission, text, readMemory(dir).fingerprint);
const base = (dir) => ['--base', readMemory(dir).fingerprint];
const exclude = (dir) => fs.readFileSync(path.join(dir, '.git', 'info', 'exclude'), 'utf8');

test('memory write replaces the memory, memory show reads it back, "\\n" is a line break', async (t) => {
  const dir = project(t);
  assert.match((await relaylead(['memory', 'show'])).out, /empty/);
  const written = await relaylead(['memory', 'write', ...base(dir), '--text', '# Memory\\n- use tabs']);
  assert.strictEqual(written.code, 0, written.err);
  assert.strictEqual(fs.readFileSync(memoryFile(dir), 'utf8'), '# Memory\n- use tabs\n');
  const shown = (await relaylead(['memory', 'show'])).out;
  assert.strictEqual(shown, `Memory fingerprint (give it to \`relaylead memory write\` as --base): ${readMemory(dir).fingerprint}\n# Memory\n- use tabs\n`);
  const file = path.join(dir, 'next.md');
  fs.writeFileSync(file, 'from a file\n');
  assert.strictEqual((await relaylead(['memory', 'write', ...base(dir), '--file', file])).code, 0);
  assert.strictEqual(fs.readFileSync(memoryFile(dir), 'utf8'), 'from a file\n');
  assert.strictEqual((await relaylead(['memory', 'write'])).code, 1);
  assert.strictEqual((await relaylead(['memory', 'write', '--text', 'no base'])).code, 1);
  assert.strictEqual((await relaylead(['memory', 'write', ...base(dir), '--text', '  '])).code, 1);
});

test('a write based on an older reading is refused, whatever was written in between', async (t) => {
  const dir = project(t);
  const mine = await relaylead(['memory', 'show']);
  const fingerprint = /: (\w+)\n/.exec(mine.out)[1];
  await writeMemory('demo', 'the other mission', dir);
  const refused = await relaylead(['memory', 'write', '--base', fingerprint, '--text', 'mine']);
  assert.strictEqual(refused.code, 1);
  assert.match(refused.err, /changed since you read it/);
  assert.strictEqual(fs.readFileSync(memoryFile(dir), 'utf8'), 'the other mission\n');
  const again = await relaylead(['memory', 'write', ...base(dir), '--text', 'the other mission\\nmine']);
  assert.strictEqual(again.code, 0, again.err);
});

test('the old version goes to the archive, and the memory stays in the project folder', async (t) => {
  const dir = project(t);
  await writeMemory('demo', 'first', dir);
  await writeMemory('demo', 'second', dir);
  const archived = fs.readdirSync(archiveDir(dir));
  assert.strictEqual(archived.length, 1);
  assert.strictEqual(fs.readFileSync(path.join(archiveDir(dir), archived[0]), 'utf8'), 'first\n');
  assert.strictEqual(fs.readFileSync(memoryFile(dir), 'utf8'), 'second\n');
});

test('writes at the same time under the lock all land, none is lost or torn', async (t) => {
  const dir = project(t);
  const texts = Array.from({ length: 6 }, (_, i) => `entry ${i}`);
  const read = readMemory(dir).fingerprint; // every lead has read the memory before the first write
  const results = await Promise.allSettled(texts.map((text) => write('demo', text, read)));
  // All read the empty memory: one write lands, the others are refused as changed, none is torn.
  assert.strictEqual(results.filter((r) => r.status === 'fulfilled').length, 1);
  for (const r of results.filter((r) => r.status === 'rejected')) assert.strictEqual(r.reason.code, 'memory-changed');
  assert.ok(texts.map((text) => text + '\n').includes(fs.readFileSync(memoryFile(dir), 'utf8')));
  assert.deepStrictEqual(fs.readdirSync(path.join(home(), 'locks')).filter((name) => name.startsWith('memory-')), []);
});

test('the memory is excluded from git, without touching .gitignore, unless it is versioned', async (t) => {
  const dir = project(t);
  await writeMemory('demo', 'one', dir);
  await writeMemory('demo', 'two', dir);
  assert.strictEqual(exclude(dir).split('\n').filter((line) => line === '.relaylead/memoire.md').length, 1);
  assert.match(exclude(dir), /^\.relaylead\/memoire-archive\/$/m);
  assert.ok(!fs.existsSync(path.join(dir, '.gitignore')));

  const versioned = project(t, { memory: { versioned: true } });
  await writeMemory('demo', 'one', versioned);
  assert.match(exclude(versioned), /^\.relaylead\/\*\n!\.relaylead\/memoire\.md$/m);
  assert.doesNotMatch(exclude(versioned), /^\.relaylead\/memoire\.md$/m);
});

test('a text over the ceiling is refused, and a memory over it is flagged by show', async (t) => {
  const dir = project(t, { memory: { maxLines: 3 } });
  const refused = await relaylead(['memory', 'write', ...base(dir), '--text', 'a\\nb\\nc\\nd']);
  assert.strictEqual(refused.code, 1);
  assert.match(refused.err, /4 lines, over the ceiling of 3/);
  assert.ok(!fs.existsSync(memoryFile(dir)));
  fs.mkdirSync(path.dirname(memoryFile(dir)), { recursive: true });
  fs.writeFileSync(memoryFile(dir), '1\n2\n3\n4\n5\n');
  const shown = await relaylead(['memory', 'show']);
  assert.match(shown.out, /\nWARNING: this memory has 5 lines, over the ceiling of 3\. Compact it before you start/);
  assert.ok(shown.out.endsWith('\n\n1\n2\n3\n[truncated: 2 lines not shown]\n'), shown.out);
  writeJson(path.join(home(), 'config.json'), { language: 'fr', delivery: { type: 'files' } });
  assert.match((await relaylead(['memory', 'show'])).out, /\nATTENTION : cette mémoire fait 5 lignes/);
});

test('the ceiling is 200 lines by default, and enabled false turns the memory off', async (t) => {
  const dir = project(t);
  fs.mkdirSync(path.dirname(memoryFile(dir)), { recursive: true });
  fs.writeFileSync(memoryFile(dir), 'x\n'.repeat(200));
  assert.doesNotMatch((await relaylead(['memory', 'show'])).out, /WARNING/);
  fs.writeFileSync(memoryFile(dir), 'x\n'.repeat(201));
  assert.match((await relaylead(['memory', 'show'])).out, /WARNING: this memory has 201 lines, over the ceiling of 200/);

  const off = project(t, { memory: { enabled: false } });
  assert.match((await relaylead(['memory', 'show'])).out, /turned off/);
  const refused = await relaylead(['memory', 'write', ...base(off), '--text', 'x']);
  assert.strictEqual(refused.code, 1);
  assert.match(refused.err, /turned off/);
  assert.ok(!fs.existsSync(memoryFile(off)));
});

test('doctor warns about a memory over the ceiling in the folder it runs in', async (t) => {
  const env = installEnv(t);
  const repo = gitRepo({ 'README.md': 'toy\n' });
  writeJson(path.join(repo, '.relaylead.json'), { memory: { maxLines: 2 } });
  fs.mkdirSync(path.join(repo, '.relaylead'));
  fs.writeFileSync(path.join(repo, '.relaylead', 'memoire.md'), 'a\nb\n');
  assert.match((await runRelaylead(['doctor'], { cwd: repo, env })).out, /^ok memory: 2 lines/m);
  fs.writeFileSync(path.join(repo, '.relaylead', 'memoire.md'), 'a\nb\nc\n');
  const result = await runRelaylead(['doctor'], { cwd: repo, env });
  assert.match(result.out, /^warn memory: 3 lines, over the ceiling of 2/m);
});

test('init --yes takes the defaults: memory on, out of git; the flags answer the questions', async (t) => {
  const env = installEnv(t);
  const repo = gitRepo({ 'README.md': 'toy\n' });
  const result = await runRelaylead(['init', '--yes'], { cwd: repo, env });
  assert.strictEqual(result.code, 0, result.err);
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(repo, '.relaylead.json'), 'utf8')).memory, { enabled: true, versioned: false });
  assert.match(exclude(repo), /^\.relaylead\/memoire\.md$/m);

  const other = gitRepo({ 'README.md': 'toy\n' });
  await runRelaylead(['init', '--yes', '--versioned-memory'], { cwd: other, env });
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(other, '.relaylead.json'), 'utf8')).memory, { enabled: true, versioned: true });
  assert.match(exclude(other), /^!\.relaylead\/memoire\.md$/m);

  const off = gitRepo({ 'README.md': 'toy\n' });
  await runRelaylead(['init', '--yes', '--no-memory'], { cwd: off, env });
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(off, '.relaylead.json'), 'utf8')).memory, { enabled: false, versioned: false });
  assert.doesNotMatch(exclude(off), /memoire/);
});

test('the lead profile and its first message tell it to read and compact the memory', () => {
  const lead = fs.readFileSync(path.join(__dirname, '..', 'catalog', 'profiles', 'lead.md'), 'utf8');
  assert.match(lead, /Bash\(relaylead memory \*\)/);
  assert.match(lead, /Before you declare the mission done, compact the project memory/);
  assert.match(lead, /then `relaylead memory show`/);
});

test('the memory of a mission started in a worktree or a sub-folder is the main repository\'s', async (t) => {
  freshHome(t);
  const main = gitRepo({ 'README.md': 'toy\n', 'sub/file.txt': 'x\n' });
  const linked = path.join(fs.realpathSync.native(tmpDir('relaylead-linked-')), 'wt');
  runFileSync('git', ['worktree', 'add', '-q', '-b', 'side', linked], { cwd: main, stdio: 'ignore' });
  assert.strictEqual(projectRoot(linked), main);
  assert.strictEqual(projectRoot(path.join(main, 'sub')), main);
  writeMission('demo', linked);
  await writeMemory('demo', 'shared', main);
  assert.strictEqual(fs.readFileSync(memoryFile(main), 'utf8'), 'shared\n');
  assert.ok(!fs.existsSync(path.join(linked, '.relaylead', 'memoire.md')));
  assert.match(exclude(main), /^\.relaylead\/memoire\.md$/m);
});

test('a versioned memory stays visible to git after the delivery excluded .relaylead/', async (t) => {
  const dir = project(t, { memory: { versioned: true } });
  excludeRelaylead(dir); // what the first delivery does: before, it excluded the whole folder
  fs.writeFileSync(path.join(dir, '.git', 'info', 'exclude'), '.relaylead/\n.relaylead/memoire.md\n');
  await writeMemory('demo', 'one', dir);
  await writeMemory('demo', 'two', dir); // archives the first
  excludeRelaylead(dir);
  const ignored = (file) => {
    try {
      runFileSync('git', ['check-ignore', '-q', file], { cwd: dir, stdio: 'ignore' });
      return true;
    } catch {
      return false;
    }
  };
  assert.strictEqual(ignored('.relaylead/memoire.md'), false);
  assert.strictEqual(ignored('.relaylead/worktrees/a/file'), true);
  assert.strictEqual(ignored('.relaylead/memoire-archive/x.md'), true);
  assert.match(runFileSync('git', ['status', '--porcelain', '-uall'], { cwd: dir, encoding: 'utf8' }), /\.relaylead\/memoire\.md/);
});

test('over the byte ceiling, show prints only what fits and says so; write refuses; maxLines is bounded', async (t) => {
  const dir = project(t, { memory: { maxBytes: 1024, maxLines: 5000 } });
  const line = 'x'.repeat(99) + '\n'; // 100 bytes
  fs.mkdirSync(path.dirname(memoryFile(dir)), { recursive: true });
  fs.writeFileSync(memoryFile(dir), line.repeat(30));
  const shown = (await relaylead(['memory', 'show'])).out;
  assert.match(shown, /WARNING: this memory is 3000 bytes, over the ceiling of 1024/);
  assert.match(shown, /\[truncated: 20 lines not shown\]\n$/);
  assert.strictEqual(shown.split(line).length - 1, 10);
  const refused = await relaylead(['memory', 'write', ...base(dir), '--text', ('y'.repeat(99) + '\\n').repeat(11)]);
  assert.strictEqual(refused.code, 1);
  assert.match(refused.err, /bytes, over the ceiling of 1024/);
  assert.strictEqual((await relaylead(['memory', 'write', ...base(dir), '--text', 'short'])).code, 0);
  // maxLines 5000 is out of range: the default 200 applies
  assert.strictEqual(readMemory(dir).maxLines, 200);
});

test('a lead cannot declare the mission done before it has written the memory', async (t) => {
  const dir = project(t);
  writeJson(path.join(missionDir('demo'), 'lead.json'), { sessionName: 'demo/lead/1', shortId: 'x', startedAt: new Date().toISOString() });
  const lead = { RELAYLEAD_MISSION: 'demo', RELAYLEAD_ROLE: 'lead', RELAYLEAD_SESSION: 'demo/lead/1' };
  const refused = await relaylead(['state', 'set', 'done'], lead);
  assert.strictEqual(refused.code, 1);
  assert.match(refused.err, /compact the project memory first/);
  assert.notStrictEqual((await relaylead(['state', 'get'], lead)).out.trim(), 'done');
  writeJson(path.join(home(), 'config.json'), { language: 'fr', delivery: { type: 'files' } });
  assert.match((await relaylead(['state', 'set', 'done'], lead)).err, /compactez d'abord la mémoire/);
  writeJson(path.join(home(), 'config.json'), { delivery: { type: 'files' } });

  assert.strictEqual((await relaylead(['memory', 'write', ...base(dir), '--text', '- demo: done'], lead)).code, 0);
  assert.strictEqual((await relaylead(['state', 'set', 'done'], lead)).code, 0);
  assert.strictEqual((await relaylead(['state', 'get'], lead)).out.trim(), 'done');
});

test('--no-memory lets a lead finish without the memory, and a memory turned off asks nothing', async (t) => {
  project(t);
  writeJson(path.join(missionDir('demo'), 'lead.json'), { sessionName: 'demo/lead/1', shortId: 'x', startedAt: new Date().toISOString() });
  const lead = { RELAYLEAD_MISSION: 'demo', RELAYLEAD_ROLE: 'lead', RELAYLEAD_SESSION: 'demo/lead/1' };
  assert.strictEqual((await relaylead(['state', 'set', 'done', '--no-memory'], lead)).code, 0);

  project(t, { memory: { enabled: false } });
  writeJson(path.join(missionDir('demo'), 'lead.json'), { sessionName: 'demo/lead/1', shortId: 'x', startedAt: new Date().toISOString() });
  assert.strictEqual((await relaylead(['state', 'set', 'done'], lead)).code, 0);
});

test('state set done is refused out of a session too, until the memory is written', async (t) => {
  const dir = project(t);
  const refused = await relaylead(['state', 'set', 'done', '--mission', 'demo']);
  assert.strictEqual(refused.code, 1);
  assert.match(refused.err, /compact the project memory first/);
  assert.strictEqual((await relaylead(['memory', 'write', '--mission', 'demo', ...base(dir), '--text', '- demo: done'])).code, 0);
  assert.strictEqual((await relaylead(['state', 'set', 'done', '--mission', 'demo'])).code, 0);
});
