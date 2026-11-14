import { defineConfig } from "vitest/config";

// Three projects, told apart by file suffix. Each glob must match at least one
// file: there is no passWithNoTests, so a broken glob fails the run.
const PROPERTY = "server/**/*.property.test.ts";
const INTEGRATION = "server/**/*.integration.test.ts";

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "unit",
          include: ["server/**/*.test.ts"],
          exclude: [PROPERTY, INTEGRATION],
          environment: "node",
        },
      },
      {
        test: { name: "property", include: [PROPERTY], environment: "node" },
      },
      {
        test: { name: "integration", include: [INTEGRATION], environment: "node" },
      },
    ],
  },
});
