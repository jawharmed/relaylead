const { codedError } = require('./messages');

// RELAYLEAD_PLATFORM replaces the real platform, so the tests can act as if on another system.
function platform() {
  return process.env.RELAYLEAD_PLATFORM || process.platform;
}

// install and uninstall register a launchd agent: macOS only for now.
function assertSupported() {
  if (platform() !== 'darwin') throw codedError('platform-unsupported', { platform: platform() });
}

module.exports = { platform, assertSupported };
