// Picks how finished tasks are delivered (config `delivery.type`).
const localMerge = require('./local-merge');
const files = require('./files');
const githubPr = require('./github-pr');

function getDelivery(type) {
  if (type === 'local-merge') return localMerge;
  if (type === 'files') return files;
  if (type === 'github-pr') return githubPr;
  throw new Error(`unknown delivery "${type}": use local-merge, files or github-pr`);
}

module.exports = { getDelivery };
