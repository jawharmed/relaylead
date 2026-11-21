// The fake gh (fixtures/fake-gh.js) for the tests: never the real GitHub.
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { tmpDir } = require('./helpers');

const BIN = path.join(__dirname, 'bin');

// The first `gh` of a PATH, or null.
function firstGh(searchPath) {
  for (const dir of searchPath.split(path.delimiter)) {
    if (fs.existsSync(path.join(dir, 'gh'))) return path.join(dir, 'gh');
  }
  return null;
}

// Gives the fake GitHub `state` (see fixtures/fake-gh.js) and a PATH of the fake gh, node and git
// only, for the time of the test. Fails when another gh would be found first. Returns:
// calls(), each call's arguments; read(), the state now; write(state), to change it.
function fakeGh(t, state) {
  const realGit = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
  const stateFile = path.join(tmpDir('relaylead-gh-'), 'state.json');
  fs.writeFileSync(stateFile, JSON.stringify({ issues: [], prs: [], ...state }, null, 2));
  const saved = { PATH: process.env.PATH, FAKE_GH_STATE: process.env.FAKE_GH_STATE };
  process.env.PATH = [BIN, path.dirname(process.execPath), path.dirname(realGit)].join(path.delimiter);
  process.env.FAKE_GH_STATE = stateFile;
  t.after(() => {
    process.env.PATH = saved.PATH;
    if (saved.FAKE_GH_STATE === undefined) delete process.env.FAKE_GH_STATE;
    else process.env.FAKE_GH_STATE = saved.FAKE_GH_STATE;
  });
  if (firstGh(process.env.PATH) !== path.join(BIN, 'gh')) throw new Error('a gh other than the fake one comes first on the PATH');
  const log = `${stateFile}.log`;
  return {
    calls: () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line)) : []),
    read: () => JSON.parse(fs.readFileSync(stateFile, 'utf8')),
    write: (next) => fs.writeFileSync(stateFile, JSON.stringify(next, null, 2)),
  };
}

// An issue of the fake GitHub, with the label relaylead.
function issue(number, title, state = 'OPEN') {
  return { number, title, body: `Do ${title}.`, state, labels: ['relaylead'] };
}

module.exports = { fakeGh, issue };
