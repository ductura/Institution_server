// Public interface of server/public-verification; other areas import only this file.
export {
  createPublicVerification,
  createPublicVerificationByCode,
  type PublicVerification,
  type PublicVerificationByCode,
  type PublicVerificationAnswer,
  type PublicVerificationResult,
} from "./verify-receipt.ts";
