// Public interface of server/downloads/submission-package (SRV-1807): the
// 24 hour link to a submission package and what it hands out.
export {
  buildSubmissionPackage,
  REFERADA_CONFIRMATION_FILENAME,
  type SubmissionPackageBuild,
} from "./build.ts";
export {
  checkPackageLink,
  issuePackageLink,
  PACKAGE_KINDS,
  PACKAGE_LINK_TTL_MS,
  type PackageKind,
  type PackageLink,
  type PackageLinkCheck,
} from "./link.ts";
