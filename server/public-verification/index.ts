// Public interface of server/public-verification; other areas import only this file.
export {
  createPublicVerification,
  type PublicVerification,
  type PublicVerificationAnswer,
  type PublicVerificationResult,
} from "./verify-receipt.ts";
