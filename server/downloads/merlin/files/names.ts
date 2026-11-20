// The names of a student's files in the Merlin package and their fingerprints
// (SRV-1109, D-286 "naziv datoteke u zipu"). A name is ASCII only, so every
// unzip tool and Merlin keep it as written: the Croatian letters are folded,
// anything else becomes "-". The first 8 hex digits of the student id keep two
// students with the same name apart. Decomposition drops the marks of the
// Croatian letters with a caron or an acute; dj has none and is folded by hand.
import { createHash } from "node:crypto";

/** U+0111, the Croatian letter dj (lower case after toLowerCase). */
const DJ = 0x111;

function slug(text: string): string {
  return [...text.normalize("NFC").toLowerCase()]
    .map((ch) => (ch.codePointAt(0) === DJ ? "dj" : ch))
    .join("")
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "");
}

/** prezime-ime-<8 hex>, or student-<8 hex> without a name pair. */
export function fileBaseName(
  familyName: string | null,
  givenName: string | null,
  studentId: string,
): string {
  const short = studentId.replaceAll("-", "").slice(0, 8);
  const name = [familyName ?? "", givenName ?? ""].map(slug).filter((part) => part !== "");
  return [...(name.length === 0 ? ["student"] : name), short].join("-");
}

/** Lowercase hex SHA-256 of the bytes. */
export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
