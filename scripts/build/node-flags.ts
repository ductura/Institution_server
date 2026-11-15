// Node options every process of the server runs with (DAN-772). With
// --disallow-code-generation-from-strings, eval, Function and the Function
// constructor of any function (plain, async, generator) throw EvalError
// instead of running a string as code, also when a key is built at run time or
// the call is inside a dependency, which the lint rule local/no-dynamic-load
// (DAN-770) cannot see. The flag does not cover node:vm, worker_threads with
// eval, data: imports, Module#_compile or WebAssembly: server code cannot
// import node:vm, node:worker_threads or node:module (lint), but a dependency
// could, and the flag would not stop it (dist/server.js has none today).
// `pnpm start` and every test that starts a server process use this list
// (scripts/build/node-flags.test.ts, server/code-generation.integration.test.ts).
export const SERVER_NODE_FLAGS: readonly string[] = ["--disallow-code-generation-from-strings"];

/** The `start` script of package.json: the built server under SERVER_NODE_FLAGS. */
export const START_SCRIPT = `node ${SERVER_NODE_FLAGS.join(" ")} dist/server.js`;
