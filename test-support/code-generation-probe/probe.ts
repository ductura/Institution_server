// Loaded with `node --import` before the server entry, so it runs in the same
// process and the same context as the server's code (DAN-772). Each attempt
// tries to run a string as code; the line names what happened, never a value.
type Outcome = "ran" | string;

function attempt(run: () => unknown): Outcome {
  try {
    run();
    return "ran";
  } catch (error) {
    return (error as Error).constructor.name;
  }
}

const results: Record<string, Outcome> = {
  "Function(string)": attempt(() => Function("return 1")()),
  "new Function(string)": attempt(() => new Function("return 1")()),
  "(() => 0).constructor(string)": attempt(() => (() => 0).constructor("return 1")()),
  "async function constructor": attempt(() => (async () => 0).constructor("return 1")),
  "generator function constructor": attempt(() => function* () {}.constructor("return 1")),
  "indirect eval": attempt(() => (0, eval)("1")),
};

console.log(JSON.stringify({ event: "codegen.probe", results }));
