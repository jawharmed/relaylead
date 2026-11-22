// The project memory: `relaylead memory show|write`, its lock, archive, git exclusion and ceiling,
// the check of doctor, and the questions of init.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { run } = require('../core/cli');
const { home } = require('../core/paths');
const { writeMemory, memoryFile, archiveDir } = require('../core/memory');
const { writeJson } = require('../core/store');
const { gitRepo } = require('../fixtures/git');
const { installEnv, runRelaylead } = require('../fixtures/install-env');
const { makeIo } = require('../fixtures/helpers');
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

const exclude = (dir) => fs.readFileSync(path.join(dir, '.git', 'info', 'exclude'), 'utf8');

test('memory write replaces the memory, memory show reads it back, "\\n" is a line break', async (t) => {
  const dir = project(t);
  assert.match((await relaylead(['memory', 'show'])).out, /empty/);
  const written = await relaylead(['memory', 'write', '--text', '# Memory\\n- use tabs']);
  assert.strictEqual(written.code, 0, written.err);
  assert.strictEqual(fs.readFileSync(memoryFile(dir), 'utf8'), '# Memory\n- use tabs\n');
  assert.strictEqual((await relaylead(['memory', 'show'])).out, '# Memory\n- use tabs\n');
  const file = path.join(dir, 'next.md');
  fs.writeFileSync(file, 'from a file\n');
  assert.strictEqual((await relaylead(['memory', 'write', '--file', file])).code, 0);
  assert.strictEqual(fs.readFileSync(memoryFile(dir), 'utf8'), 'from a file\n');
  assert.strictEqual((await relaylead(['memory', 'write'])).code, 1);
  assert.strictEqual((await relaylead(['memory', 'write', '--text', '  '])).code, 1);
});

test('the old version goes to the archive, and the memory stays in the project folder', async (t) => {
  const dir = project(t);
  await writeMemory('demo', 'first');
  await writeMemory('demo', 'second');
  const archived = fs.readdirSync(archiveDir(dir));
  assert.strictEqual(archived.length, 1);
  assert.strictEqual(fs.readFileSync(path.join(archiveDir(dir), archived[0]), 'utf8'), 'first\n');
  assert.strictEqual(fs.readFileSync(memoryFile(dir), 'utf8'), 'second\n');
});

test('writes at the same time under the lock all land, none is lost or torn', async (t) => {
  const dir = project(t);
  const texts = Array.from({ length: 6 }, (_, i) => `entry ${i}`);
  await Promise.all(texts.map((text) => writeMemory('demo', text)));
  assert.ok(texts.map((text) => text + '\n').includes(fs.readFileSync(memoryFile(dir), 'utf8')));
  assert.strictEqual(fs.readdirSync(archiveDir(dir)).length, 5);
  assert.deepStrictEqual(fs.readdirSync(path.join(home(), 'locks')).filter((name) => name.startsWith('memory-')), []);
});

test('the memory is excluded from git, without touching .gitignore, unless it is versioned', async (t) => {
  const dir = project(t);
  await writeMemory('demo', 'one');
  await writeMemory('demo', 'two');
  assert.strictEqual(exclude(dir).split('\n').filter((line) => line === '.relaylead/memoire.md').length, 1);
  assert.match(exclude(dir), /^\.relaylead\/memoire-archive\/$/m);
  assert.ok(!fs.existsSync(path.join(dir, '.gitignore')));

  const versioned = project(t, { memory: { versioned: true } });
  await writeMemory('demo', 'one');
  assert.doesNotMatch(exclude(versioned), /memoire/);
});

test('a text over the ceiling is refused, and a memory over it is flagged by show', async (t) => {
  const dir = project(t, { memory: { maxLines: 3 } });
  const refused = await relaylead(['memory', 'write', '--text', 'a\\nb\\nc\\nd']);
  assert.strictEqual(refused.code, 1);
  assert.match(refused.err, /4 lines, over the ceiling of 3/);
  assert.ok(!fs.existsSync(memoryFile(dir)));
  fs.mkdirSync(path.dirname(memoryFile(dir)), { recursive: true });
  fs.writeFileSync(memoryFile(dir), '1\n2\n3\n4\n5\n');
  const shown = await relaylead(['memory', 'show']);
  assert.match(shown.out, /^WARNING: this memory has 5 lines, over the ceiling of 3\. Compact it before you start/);
  assert.ok(shown.out.endsWith('1\n2\n3\n4\n5\n'));
  writeJson(path.join(home(), 'config.json'), { language: 'fr', delivery: { type: 'files' } });
  assert.match((await relaylead(['memory', 'show'])).out, /^ATTENTION : cette mémoire fait 5 lignes/);
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
  const refused = await relaylead(['memory', 'write', '--text', 'x']);
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
  assert.doesNotMatch(exclude(other), /memoire/);

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
