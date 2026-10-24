/**
 * @param {string} name
 * @returns {unknown}
 */
function loadDynamic(name) {
  return require(name);
}

const load = require;

function loadAliased() {
  return load("./greet.js");
}

module.exports = { loadDynamic, loadAliased };
