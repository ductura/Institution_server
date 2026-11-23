// `pnpm dev:lazni-server`: the dev fake server on 127.0.0.1, port from
// DUCTURA_LAZNI_PORT (4010 by default); works of schema 1, or 3 with
// DUCTURA_LAZNI_SHEMA=3 (LOK-SRV-V3). Local development only (D-09).
import {
  createDevServer,
  createState,
  DEV_HANDLERS,
  devServerPort,
  devWorkSchema,
} from "./index.ts";

const port = devServerPort(process.env);
const schema = devWorkSchema(process.env);
if (typeof port === "string" || typeof schema === "string") {
  console.error(typeof port === "string" ? port : schema);
  process.exit(1);
}
createDevServer(DEV_HANDLERS, createState(undefined, schema)).listen(port, "127.0.0.1", () => {
  console.log(
    `Lažni server: http://127.0.0.1:${port}/api/v1 (uloga: /__lazni/uloga, shema radova ${schema})`,
  );
});
