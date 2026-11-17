// DAN-852-1: the public interface of server/institution (docs/server-map.md).
import { describe, expect, expectTypeOf, it } from "vitest";
import * as area from "./index.ts";
import type { CourseBody, InstitutionService } from "./index.ts";

describe("server/institution public interface", () => {
  it("exports only the course body parser", () => {
    expect(Object.keys(area)).toEqual(["parseCourseBody"]);
  });

  it("has a service type without members and a closed course body", () => {
    expectTypeOf<InstitutionService[string]>().toEqualTypeOf<never>();
    expectTypeOf<keyof CourseBody>().toEqualTypeOf<"name" | "academicYear" | "aiPolicy">();
  });
});
