// SRV-8F: who a published change belongs to is decided from the stored
// suggestion, never from the client's claim (§4.15 invariant 4, PRODUCT §5
// rule 8). Only a write whose result is exactly the stored suggestion applied
// to the state before it is recorded as the teacher's suggestion; anything
// else is the student's own change.
import { documentsEqual, type CanonicalDocument } from "../../domain/document/index.ts";

import { applySuggestion, type SuggestionChange } from "./apply.ts";
import type { Suggestion } from "./suggestion.ts";

export type Attribution =
  | { readonly source: "teacher-suggestion"; readonly change: SuggestionChange }
  | { readonly source: "student" };

export function attributeChange(
  documentId: string,
  before: CanonicalDocument,
  after: CanonicalDocument,
  suggestion: Suggestion,
): Attribution {
  if (suggestion.documentId !== documentId) return { source: "student" };
  const applied = applySuggestion(before, suggestion);
  if (!applied.ok || !documentsEqual(applied.document, after)) return { source: "student" };
  return { source: "teacher-suggestion", change: applied.change };
}
