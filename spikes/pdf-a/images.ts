// Container images of the spike, pinned by the digest of the multi-arch index
// (pulled 21. 11. 2026). A tag is only a note for the reader; Docker resolves
// the digest. D-254 asks for a pinned image, D-253 keeps veraPDF in a pinned
// container and out of package.json.

/** Gotenberg 8.40.0, LibreOffice 26.8.2.2, fonts-liberation 2.1.5 (SIL OFL 1.1). */
export const LIBREOFFICE_IMAGE =
  "gotenberg/gotenberg@sha256:53073e798c8ef39ea2187e44cb67bab77894ea2509100b94c4fe3b461f7b2996";

/** veraPDF CLI 1.30.4. */
export const VERAPDF_IMAGE =
  "verapdf/cli@sha256:c2ac9448973a56acd833c81441e38d2dca58ea26a2ce1621e9a32e85d3d2728f";

const PINNED = /^[a-z0-9]+(?:[._/-][a-z0-9]+)*@sha256:[0-9a-f]{64}$/u;

export function isPinnedByDigest(image: string): boolean {
  return PINNED.test(image);
}
