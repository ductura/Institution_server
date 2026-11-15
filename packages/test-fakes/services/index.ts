// Public interface of the fake outside services (U9).
import "../guard/index.ts";

export {
  createFakeService,
  FAKE_SERVICE_MODES,
  type FakeService,
  type FakeServiceMode,
  type FakeServiceOptions,
} from "./services.ts";
