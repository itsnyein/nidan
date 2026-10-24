// The fixture does not install @types/node. TypeScript special-cases `require("literal")`
// in a JavaScript file but not a computed one, so the computed form needs a declaration
// for the case to compile — which it must, or it would be testing error recovery.
declare function require(id: string): unknown;
