const lib = require("./lib.js");

function callAll() {
  return lib.alpha() + lib.bravo() + lib.pack.charlie();
}

module.exports = { callAll };
