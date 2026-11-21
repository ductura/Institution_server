import type { WithActor } from "../index.ts";

export type SourceNoteFields = Partial<Record<"quote" | "page" | "note", string | null>>;
type Operation = "GET" | "POST" | "PATCH" | "DELETE";

export function createSourceNotebook(withActor: WithActor) {
  return async (
    token: string,
    documentId: string,
    sourceId: string,
    operation: Operation,
    noteId: string | null,
    fields: SourceNoteFields | null,
    acceptsResult: (result: unknown) => boolean,
  ) => {
    try {
      return await withActor(token, async (tx) => {
        const { rows } = await tx.query<{ result: unknown }>(
          "SELECT institution.source_notes($1::text, $2::uuid, $3::text, $4::uuid, $5::jsonb) AS result",
          [
            documentId,
            sourceId,
            operation,
            noteId,
            fields === null ? null : JSON.stringify(fields),
          ],
        );
        const result = rows[0]?.result;
        if (rows.length !== 1 || !acceptsResult(result))
          throw new Error("invalid source note result");
        return { status: 200, result } as const;
      });
    } catch (error) {
      const code = error instanceof Error && "code" in error ? error.code : undefined;
      if (code === "ZD401") return { status: 401, code: "unauthorized" } as const;
      if (code === "ZD403") return { status: 404, code: "not_found" } as const;
      if (code === "ZD422") return { status: 422, code: "invalid_input" } as const;
      throw error;
    }
  };
}
