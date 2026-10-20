// Two declarations with the same name at the same container level. Legal JavaScript:
// the later one wins at runtime. Their structural keys are identical, because the
// signature is not part of the key.
export function handle(count) {
  return count + 1;
}

function handle(count) {
  return count + 2;
}
