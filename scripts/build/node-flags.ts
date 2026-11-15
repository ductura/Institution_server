// Node options every process of the server runs with (DAN-772). With
// --disallow-code-generation-from-strings, eval, Function and the Function
// constructor of any function throw EvalError instead of running a string as
// code. That closes what the lint rule local/no-dynamic-load (DAN-770) cannot
// see statically: a key built at run time and the internals of dependencies.
// `pnpm start` and every test that starts a server process use this list
// (scripts/build/node-flags.test.ts, server/code-generation.integration.test.ts).
export const SERVER_NODE_FLAGS: readonly string[] = ["--disallow-code-generation-from-strings"];

/** The `start` script of package.json: the built server under SERVER_NODE_FLAGS. */
export const START_SCRIPT = `node ${SERVER_NODE_FLAGS.join(" ")} dist/server.js`;
