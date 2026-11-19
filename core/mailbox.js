// The mailbox of a session: what Relaylead has to tell a session that runs, through files only (no
// command ever writes to a live session). Addressed to the short id, which a wake or a relaunch by
// Claude's own service keeps (measured fact 4). One file per message,
// missions/<m>/mailbox/<shortId>/<nnnnnn>-<time>.md: the core creates it by an exclusive link, the
// session's hook moves it into read/ once passed on, and nobody ever writes it again.
const fs = require('node:fs');
const path = require('node:path');
const { missionDir } = require('./paths');
const { writeTextExclusive, withWindowsRetry } = require('./store');

const PREFIX = 'Message from Relaylead: ';

function mailDir(mission, shortId) {
  return path.join(missionDir(mission), 'mailbox', shortId);
}

function readDir(mission, shortId) {
  return path.join(mailDir(mission, shortId), 'read');
}

// The messages of a folder, by name; none when the folder does not exist. A temporary file of
// writeTextExclusive ends in .tmp, never in .md.
function messageNames(dir) {
  try {
    return fs.readdirSync(dir).filter((name) => name.endsWith('.md')).sort();
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
}

// Writes a message and returns its path. The number counts every message the session ever got,
// read ones included, so names only grow, whatever the clock says. The unread folder is listed
// first: a message moved to read/ in between is counted twice, which only skips a number.
function sendMail(mission, shortId, text) {
  let n = messageNames(mailDir(mission, shortId)).length + messageNames(readDir(mission, shortId)).length + 1;
  for (;;) {
    const time = new Date().toISOString().replace(/[:.]/g, '-');
    const file = path.join(mailDir(mission, shortId), `${String(n).padStart(6, '0')}-${time}.md`);
    if (writeTextExclusive(file, text)) return file;
    n++;
  }
}

// The unread messages, oldest first. Moves nothing: markRead does, once they are passed on.
function readMail(mission, shortId) {
  const mail = [];
  for (const name of messageNames(mailDir(mission, shortId))) {
    const file = path.join(mailDir(mission, shortId), name);
    try {
      mail.push({ file, text: withWindowsRetry(() => fs.readFileSync(file, 'utf8')) });
    } catch (err) {
      if (err.code !== 'ENOENT') throw err; // moved by another hook of the same session meanwhile
    }
  }
  return mail;
}

// Moves each message into read/. One already moved (a hook run twice) is skipped. read/ is made
// inside the session's mailbox only: the folder of a removed mission is never made again.
function markRead(mission, shortId, files) {
  if (files.length === 0) return;
  const dir = readDir(mission, shortId);
  try {
    fs.mkdirSync(dir);
  } catch (err) {
    if (err.code !== 'EEXIST') throw err;
  }
  for (const file of files) {
    try {
      withWindowsRetry(() => fs.renameSync(file, path.join(dir, path.basename(file))));
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
  }
}

function unreadCount(mission, shortId) {
  return messageNames(mailDir(mission, shortId)).length;
}

// For the hooks: prints the unread mail, each message prefixed and separated by a blank line, in
// the output `toOutput` makes of it, then moves it into read/ once printed. A hook killed in
// between passes the mail on again next time: a message read twice is harmless (the instructions
// can be played again), a lost one is not. Prints nothing without mail.
function passMail(mission, shortId, toOutput) {
  const mail = readMail(mission, shortId);
  if (mail.length === 0) return;
  const text = mail.map((one) => PREFIX + one.text).join('\n\n');
  process.stdout.write(JSON.stringify(toOutput(text)), (err) => {
    if (err) return;
    try {
      markRead(mission, shortId, mail.map((one) => one.file));
    } catch {
      // Left unread: passed on again at the next hook.
    }
  });
}

module.exports = { sendMail, readMail, markRead, unreadCount, passMail };
