// Temporary in-memory store. It is replaced by a real database (e.g. PostgreSQL).
import type { AccessDoc } from "./access.ts";

export type Doc = {
  id: string;
  title?: string;
  content?: string;
} & AccessDoc;

export type Store = {
  get(id: string): Doc | null;
  put(doc: Doc): Doc;
  listFor(userId: string): Doc[];
};

export function createStore(seed: Doc[] = []): Store {
  const docs = new Map<string, Doc>(seed.map((d) => [d.id, { ...d }]));
  return {
    get: (id) => docs.get(id) ?? null,
    put: (doc) => {
      const copy = { ...doc };
      docs.set(doc.id, copy);
      return copy;
    },
    listFor: (userId) => [...docs.values()].filter((d) => d.ownerId === userId),
  };
}
