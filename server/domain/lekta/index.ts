// Public interface of server/domain/lekta; other folders import only this file.
export {
  loadFpzgPackageV1,
  parseLektaPackage,
  ruleById,
  type LektaPackage,
  type LektaRule,
  type LektaSource,
} from "./package.ts";
