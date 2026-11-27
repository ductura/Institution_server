// XML text helpers shared by the DOCX writers.
/** Characters outside XML 1.0's allowed set are printed as U+FFFD, never dropped silently. */
function xmlSafe(text: string): string {
  let out = "";
  for (const ch of text) {
    const c = ch.codePointAt(0) ?? 0;
    const ok =
      c === 9 ||
      c === 10 ||
      c === 13 ||
      (c >= 0x20 && c <= 0xd7ff) ||
      (c >= 0xe000 && c <= 0xfffd) ||
      c >= 0x10000;
    out += ok ? ch : "�";
  }
  return out;
}

export function xmlEscape(text: string): string {
  return xmlSafe(text).replace(
    /[&<>"]/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] ?? c,
  );
}
