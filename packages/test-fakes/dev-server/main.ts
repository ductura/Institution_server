// `pnpm dev:lazni-server`: the dev fake server on 127.0.0.1, port from
// DUCTURA_LAZNI_PORT (4010 by default). Local development only (D-09).
import { createDevServer, DEV_HANDLERS, devServerPort } from "./index.ts";

const port = devServerPort(process.env);
if (typeof port === "string") {
  console.error(port);
  process.exit(1);
}
createDevServer(DEV_HANDLERS).listen(port, "127.0.0.1", () => {
  console.log(`Lažni server: http://127.0.0.1:${port}/api/v1 (uloga: /__lazni/uloga)`);
});
