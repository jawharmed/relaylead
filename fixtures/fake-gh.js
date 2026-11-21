// A fake `gh` for the tests: never calls GitHub. Started by fixtures/bin/gh.
//
// FAKE_GH_STATE names a JSON file with the fake GitHub:
//   { remote: <bare git repository standing for the GitHub repository>,
//     issues: [{ number, title, body, state: 'OPEN' | 'CLOSED', labels: [..] }],
//     prs: [{ number, head, base, title, body, state: 'OPEN' | 'MERGED', reviewDecision, url }] }
// Every call is noted in <FAKE_GH_STATE>.log, one JSON array of arguments per line.
// FAKE_GH_FAIL="<words>": a call whose arguments start with these words fails (status 1).
// FAKE_GH_NOT_LOGGED_IN=1: `auth status` fails as when nobody is logged in.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const stateFile = process.env.FAKE_GH_STATE;
const args = process.argv.slice(2);

function fail(message) {
  process.stderr.write(message + '\n');
  process.exit(1);
}

function readState() {
  return JSON.parse(fs.readFileSync(stateFile, 'utf8'));
}

// Through a temporary file and a rename: a `gh issue list` running meanwhile never reads half a file.
function writeState(state) {
  const temporary = `${stateFile}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(state, null, 2));
  fs.renameSync(temporary, stateFile);
}

// The value of --name, or undefined.
function option(name) {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
}

// The object with only the --json fields.
function pick(object) {
  const fields = option('--json').split(',');
  return Object.fromEntries(fields.map((field) => [field, object[field] === undefined ? '' : object[field]]));
}

function print(value) {
  process.stdout.write(JSON.stringify(value) + '\n');
}

function git(cwd, ...gitArgs) {
  return execFileSync('git', gitArgs, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

// A pull request by number, or by its head branch (the latest one).
function findPr(state, ref) {
  const found = state.prs.filter((pr) => String(pr.number) === ref || pr.head === ref);
  return found[found.length - 1];
}

// Merges the pull request in the "GitHub" repository, through a clone of its own.
function mergePr(state, pr) {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-gh-merge-'));
  try {
    git(work, 'clone', '-q', '--branch', pr.base, state.remote, '.');
    git(work, 'fetch', '-q', 'origin', pr.head);
    try {
      git(work, 'merge', '--no-ff', '-m', `Merge pull request #${pr.number} from ${pr.head}`, 'FETCH_HEAD');
    } catch {
      fail(`Pull request #${pr.number} is not mergeable: the merge commit cannot be cleanly created.`);
    }
    git(work, 'push', '-q', 'origin', pr.base);
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

function run() {
  fs.appendFileSync(`${stateFile}.log`, JSON.stringify(args) + '\n');
  const failing = (process.env.FAKE_GH_FAIL || '').split(' ').filter(Boolean);
  if (failing.length > 0 && failing.every((word, index) => args[index] === word)) fail(`fake failure of gh ${args.join(' ')}`);
  const [group, command, ref] = args;
  const state = readState();

  if (group === 'auth' && command === 'status') {
    if (process.env.FAKE_GH_NOT_LOGGED_IN === '1') {
      fail('You are not logged into any GitHub hosts. To log in, run: gh auth login');
    }
    process.stdout.write('Logged in to github.com account fake-user\n');
  } else if (group === 'issue' && command === 'list') {
    const label = option('--label');
    print(state.issues.filter((issue) => !label || issue.labels.includes(label)).map(pick));
  } else if (group === 'issue' && command === 'close') {
    const issue = state.issues.find((candidate) => String(candidate.number) === ref);
    if (!issue) fail(`issue ${ref} not found`);
    // Like gh: closing a closed issue only says so.
    if (issue.state === 'CLOSED') {
      process.stderr.write(`! Issue #${ref} is already closed\n`);
      return;
    }
    issue.state = 'CLOSED';
    issue.comment = option('--comment');
    writeState(state);
  } else if (group === 'pr' && command === 'list') {
    const wanted = option('--state') || 'open';
    const prs = state.prs.filter((pr) => pr.head === option('--head') && (wanted === 'all' || pr.state === wanted.toUpperCase()));
    print(prs.map(pick));
  } else if (group === 'pr' && command === 'create') {
    const head = option('--head');
    try {
      git(state.remote, 'rev-parse', '--verify', '-q', `refs/heads/${head}`);
    } catch {
      fail(`pull request create failed: head branch "${head}" was not pushed`);
    }
    const number = state.prs.length + 1;
    const url = `https://github.com/fake/repo/pull/${number}`;
    state.prs.push({ number, head, base: option('--base'), title: option('--title'), body: option('--body'), state: 'OPEN', reviewDecision: '', url });
    writeState(state);
    process.stdout.write(url + '\n');
  } else if (group === 'pr' && command === 'view') {
    const pr = findPr(state, ref);
    if (!pr) fail(`no pull requests found for branch "${ref}"`);
    print(pick(pr));
  } else if (group === 'pr' && command === 'review') {
    const pr = findPr(state, ref);
    pr.reviewDecision = args.includes('--request-changes') ? 'CHANGES_REQUESTED' : 'APPROVED';
    writeState(state);
  } else if (group === 'pr' && command === 'merge') {
    const pr = findPr(state, ref);
    if (pr.state !== 'OPEN') fail(`Pull request #${pr.number} is not open`);
    mergePr(state, pr);
    pr.state = 'MERGED';
    writeState(state);
  } else {
    fail(`fake gh: unknown command: ${args.join(' ')}`);
  }
}

run();
