// Hook PostToolUse : livre le courrier déposé pour cette session, puis le range dans read/.
const fs = require('node:fs');
const path = require('node:path');
const { readStdinJson, out } = require('./lib');

function takeMail(sessionId) {
  const dir = out('mailbox', sessionId);
  if (!fs.existsSync(dir)) return '';
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.md')).sort();
  fs.mkdirSync(path.join(dir, 'read'), { recursive: true });
  return files.map((f) => {
    const text = fs.readFileSync(path.join(dir, f), 'utf8').trim();
    fs.renameSync(path.join(dir, f), path.join(dir, 'read', f));
    return text;
  }).join('\n');
}

if (require.main === module) readStdinJson().then((j) => {
  const mail = takeMail(j.session_id || '');
  if (mail) console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PostToolUse',
    additionalContext: `Message de Relaylead : ${mail}` } }));
});
module.exports = { takeMail };
