// Picks how finished tasks are delivered (config `delivery.type`).
const localMerge = require('./local-merge');
const files = require('./files');

function getDelivery(type) {
  if (type === 'local-merge') return localMerge;
  if (type === 'files') return files;
  throw new Error(`unknown delivery "${type}": use local-merge or files`);
}

module.exports = { getDelivery };
