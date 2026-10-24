const mod = require("./greet.js");
const { greet } = require("./greet.js");

function viaNamespace() {
  return mod.greet();
}

function viaDestructured() {
  return greet();
}

module.exports = { viaNamespace, viaDestructured };
