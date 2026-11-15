const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { loadProfile } = require('../core/profiles');
const { tmpDir } = require('../fixtures/helpers');

function put(folder, name, text) {
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(path.join(folder, `${name}.md`), text);
}

test('profile lookup prefers the project, then the user, then the catalog', () => {
  const project = tmpDir('rl-project-');
  const home = tmpDir('rl-home-');
  const catalogDir = tmpDir('rl-catalog-');
  process.env.RELAYLEAD_HOME = home;
  const projectFolder = path.join(project, '.relaylead', 'profiles');
  const homeFolder = path.join(home, 'profiles');
  put(catalogDir, 'dev', '---\nagent: claude\nmodel: haiku\n---\ncatalog\n');
  put(homeFolder, 'dev', '---\nagent: claude\nmodel: sonnet\n---\nuser\n');
  put(projectFolder, 'dev', '---\nagent: claude\nmodel: opus\neffort: high\ntools: [Read, Edit]\n---\nproject\n');
  put(catalogDir, 'qa', '---\nagent: claude\n---\nOnly in catalog.\n');

  const fromProject = loadProfile('dev', { dir: project, catalogDir });
  assert.deepStrictEqual(fromProject, {
    name: 'dev', agent: 'claude', model: 'opus', effort: 'high', tools: ['Read', 'Edit'], instructions: 'project\n',
  });
  fs.rmSync(path.join(projectFolder, 'dev.md'));
  assert.strictEqual(loadProfile('dev', { dir: project, catalogDir }).model, 'sonnet');
  fs.rmSync(path.join(homeFolder, 'dev.md'));
  assert.strictEqual(loadProfile('dev', { dir: project, catalogDir }).model, 'haiku');
  const qa = loadProfile('qa', { dir: project, catalogDir });
  assert.deepStrictEqual([qa.model, qa.effort, qa.tools], [null, null, []]);

  assert.throws(() => loadProfile('ghost', { dir: project, catalogDir }), (err) => {
    assert.strictEqual(err.code, 'unknown-profile');
    assert.ok(err.message.includes(projectFolder) && err.message.includes(homeFolder) && err.message.includes(catalogDir));
    return true;
  });
});
