function alpha() {
  return "a";
}

function bravo() {
  return "b";
}

function charlie() {
  return "c";
}

module.exports.alpha = alpha;
exports.bravo = bravo;
module.exports.pack = { charlie };
