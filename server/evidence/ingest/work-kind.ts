// SRV-V14-SHEET-EVIDENCE: the one place that names the kind of a work for the
// commit preparation. Text, slides and spreadsheet; the branch of each kind is
// in its own folder (server/evidence/slides, server/evidence/sheet).

/** The kind of a work, fixed at its start (revision 0). */
export type EvidenceWorkKind = "text" | "slides" | "spreadsheet";

/**
 * The kind the commit context names. A context without `documentKind` is a
 * text work (every work before slides); any other value is no kind the server
 * knows, so the caller refuses the commit rather than guess.
 */
export function workKindOfContext(context: object): EvidenceWorkKind | null {
  const kind: unknown = "documentKind" in context ? context.documentKind : undefined;
  if (kind === undefined || kind === "text") return "text";
  if (kind === "slides" || kind === "spreadsheet") return kind;
  return null;
}
