import { expect, it } from "vitest";

import { createStore } from "./store.ts";

it("store returns only the owner's documents", () => {
  const store = createStore([
    { id: "1", ownerId: "student-a" },
    { id: "2", ownerId: "student-b" },
  ]);
  expect(store.listFor("student-a").map((d) => d.id)).toEqual(["1"]);
  expect(store.get("x")).toBeNull();
});
