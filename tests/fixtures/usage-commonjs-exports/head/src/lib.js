function alpha() {
  return "a".trim();
}

function bravo() {
  return "b".trim();
}

function charlie() {
  return "c".trim();
}

module.exports.alpha = alpha;
exports.bravo = bravo;
module.exports.pack = { charlie };
