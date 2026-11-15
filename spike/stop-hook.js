// Hook Stop : s'il reste du courrier, empêche la fin du tour et le transmet.
const { readStdinJson } = require('./lib');
const { takeMail } = require('./mailbox-hook');
readStdinJson().then((j) => {
  const mail = takeMail(j.session_id || '');
  if (mail) console.log(JSON.stringify({ decision: 'block', reason: `Message de Relaylead : ${mail}` }));
});
