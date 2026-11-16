// Public interface of the fake outside services (S-1E-c, DAN-837). Local runs
// and CI only; production code never imports test-support.
export {
  createFakeEmail,
  createFakeGate,
  createFakeKeys,
  createFakeStorage,
  type FakeGate,
  type FakeServiceSetup,
} from "./fake-services.ts";
