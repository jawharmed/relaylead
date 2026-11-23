// Picks the adapter that runs the agent sessions.
const fake = require('./fake');
const claude = require('./claude');

function getAdapter(name) {
  if (name === 'fake') return fake;
  if (name === 'claude') return claude;
  throw new Error(`unknown agent "${name}": use claude`);
}

module.exports = { getAdapter };
