import { describe, expect, it } from "vitest";

import {
  deploymentProblems,
  isProductionHost,
  isStagingDeployment,
  stagingDeploymentOrigin,
} from "./index.ts";

// STG-PRIJAVA (Ductus#2055). Synthetic hosts only.
const ORIGIN = "https://staging.ductura-proba.hr";
const UNKNOWN = "DUCTURA_DEPLOYMENT is not a known deployment";
const ON_PRODUCTION =
  "DUCTURA_DEPLOYMENT staging needs an https APP_ORIGIN outside the production domain";

describe("isProductionHost", () => {
  it.each(["ductura.org", "www.ductura.org", "WWW.DUCTURA.ORG", "ductura.org.", "a.b.ductura.org"])(
    "%s is production",
    (host) => expect(isProductionHost(host)).toBe(true),
  );
  it.each(["ductura-proba.hr", "notductura.org", "ductura.org.hr", "ductura.com", "localhost"])(
    "%s is not",
    (host) => expect(isProductionHost(host)).toBe(false),
  );
});

describe("deploymentProblems", () => {
  it("has none without the variable, whatever APP_ORIGIN is", () => {
    expect(deploymentProblems({})).toEqual([]);
    expect(deploymentProblems({ APP_ORIGIN: "https://ductura.org" })).toEqual([]);
  });

  it("has none for staging on a staging origin", () => {
    expect(deploymentProblems({ DUCTURA_DEPLOYMENT: "staging", APP_ORIGIN: ORIGIN })).toEqual([]);
  });

  it.each(["", "Staging", "staging ", "production", "prod", "test", "staging\r\n"])(
    "refuses DUCTURA_DEPLOYMENT %j by name only",
    (value) => {
      expect(deploymentProblems({ DUCTURA_DEPLOYMENT: value, APP_ORIGIN: ORIGIN })).toEqual([
        UNKNOWN,
      ]);
    },
  );

  it.each([
    undefined,
    "https://ductura.org",
    "https://www.ductura.org",
    "https://staging.ductura.org",
    "http://staging.ductura-proba.hr",
    `${ORIGIN}/`,
    "not a url",
  ])("refuses staging with APP_ORIGIN %j", (origin) => {
    const env = { DUCTURA_DEPLOYMENT: "staging", APP_ORIGIN: origin };
    expect(deploymentProblems(env)).toEqual([ON_PRODUCTION]);
    expect(isStagingDeployment(env)).toBe(false);
  });

  it("names no value", () => {
    const problems = deploymentProblems({ DUCTURA_DEPLOYMENT: "secret-ish", APP_ORIGIN: ORIGIN });
    expect(problems.join(" ")).not.toContain("secret-ish");
  });

  it("refuses a getter without calling it", () => {
    let called = false;
    const env = Object.defineProperty({ APP_ORIGIN: ORIGIN }, "DUCTURA_DEPLOYMENT", {
      get: () => {
        called = true;
        return "staging";
      },
      enumerable: true,
    });
    expect(deploymentProblems(env)).toEqual([UNKNOWN]);
    expect(isStagingDeployment(env)).toBe(false);
    expect(called).toBe(false);
  });
});

describe("stagingDeploymentOrigin", () => {
  it("is the origin only for exact staging on a staging origin", () => {
    expect(stagingDeploymentOrigin({ DUCTURA_DEPLOYMENT: "staging", APP_ORIGIN: ORIGIN })).toBe(
      ORIGIN,
    );
    expect(stagingDeploymentOrigin({ APP_ORIGIN: ORIGIN })).toBeNull();
    expect(
      stagingDeploymentOrigin({ DUCTURA_DEPLOYMENT: "staging", APP_ORIGIN: "https://ductura.org" }),
    ).toBeNull();
  });

  it("ignores an inherited switch", () => {
    const env = Object.assign(Object.create({ DUCTURA_DEPLOYMENT: "staging" }) as object, {
      APP_ORIGIN: ORIGIN,
    });
    expect(isStagingDeployment(env)).toBe(false);
    expect(deploymentProblems(env)).toEqual([]);
  });
});
