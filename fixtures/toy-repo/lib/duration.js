const ms = require('ms');

// "2 days" -> 172800000
function toMilliseconds(text) {
  return ms(text);
}

module.exports = { toMilliseconds };
