// Picks the adapter that runs the agent sessions (contract: docs/plans/2026-11-15-lot-1-squelette.md).
const fake = require('./fake');

function getAdapter(name) {
  if (name === 'fake') return fake;
  if (name === 'claude') throw new Error('agent "claude": not implemented yet');
  throw new Error(`unknown agent "${name}": use fake or claude`);
}

module.exports = { getAdapter };
