// Public interface of the invented works generator (DAN-1566).
import "../guard/index.ts";

export {
  generateInventedWork,
  serializeInventedWork,
  type InventedSource,
  type InventedWork,
  type InventedWorkOptions,
} from "./generate.ts";
