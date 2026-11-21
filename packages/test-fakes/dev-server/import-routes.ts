// A DOCX import into a work on the dev fake server (work.imports.post and
// work.imports.confirm.post, SRV-1803; M8.2, M8.2b, D-282). The file is read by
// the real reader of server/import, so the preview is the one the server
// gives; only the student owner imports, only while the assignment allows it
// and the work is not submitted. The confirmation follows the order of the
// contract and gives one event per import. The real record, its locks and the
// time are the RPCs of 20261130100000; this fake keeps imports in memory.
import { randomUUID } from "node:crypto";

import {
  IMPORT_PENDING_LIFETIME_MS,
  IMPORT_READ_LIMITS,
  MAX_IMPORT_RAW_BYTES,
} from "../../../server/contracts/index.ts";
import { prepareDocxImport } from "../../../server/import/index.ts";

import type { Operations } from "../../contracts/index.ts";

import type { Handlers } from "./server.ts";
import { readerOf, type State, type Work } from "./state.ts";

/** The reader builds only text blocks; the contract names that narrower shape. */
type PreviewContent = Operations["work.imports.post"]["success"]["body"]["content"];

type Prepared = {
  readonly documentId: string;
  readonly manifestSha256: string;
  readonly preparedAt: number;
  readonly baseRevision: number;
  eventId: string | null;
};

/**
 * The ids of the n-th import of a fake state (from 1): a fixed import id and
 * fixed node ids, so a scenario can name the import and its manifest hash.
 */
export function fakeImportIds(n: number): { importId: string; uuid: () => string } {
  const hex = n.toString(16).padStart(12, "0");
  let node = 0;
  return {
    importId: `0000017e-0000-4000-8000-${hex}`,
    uuid: () => {
      node += 1;
      return `${n.toString(16).padStart(8, "0")}-0000-4000-9000-${node.toString(16).padStart(12, "0")}`;
    },
  };
}

/** The imports of each fake state, by import id. */
const IMPORTS = new WeakMap<State, Map<string, Prepared>>();

function importsOf(state: State): Map<string, Prepared> {
  let all = IMPORTS.get(state);
  if (all === undefined) IMPORTS.set(state, (all = new Map()));
  return all;
}

/** "Dopušten uvoz" on the current version and the work not submitted. */
function takesImport(state: State, work: Work): boolean {
  const assignment = state.assignments.find((a) => a.id === work.assignmentId);
  return assignment?.content.importAllowed === true && work.state !== "submitted";
}

export const IMPORT_HANDLERS: Handlers = {
  "work.imports.post": ({ state, account, params, body, now }) => {
    if (account === null) return { error: "unauthorized" };
    const work = state.works.find((w) => w.documentId === params.documentId);
    if (work === undefined || readerOf(state, work, account) !== "owner")
      return { error: "not_found" };
    if (!takesImport(state, work)) return { error: "import_not_allowed" };
    const bytes = Buffer.from(body.fileBase64, "base64");
    if (bytes.toString("base64") !== body.fileBase64) return { error: "invalid_input" };
    if (bytes.length > MAX_IMPORT_RAW_BYTES) return { error: "body_too_large" };
    const ids = fakeImportIds(importsOf(state).size + 1);
    const prepared = prepareDocxImport({
      bytes: new Uint8Array(bytes),
      documentId: work.documentId,
      fileName: body.fileName,
      limits: IMPORT_READ_LIMITS,
      importId: ids.importId,
      uuid: ids.uuid,
    });
    if (!prepared.ok) {
      return { error: prepared.code === "MANIFEST_INVALID" ? "invalid_input" : "invalid_document" };
    }
    const { preview } = prepared;
    importsOf(state).set(preview.importId, {
      documentId: work.documentId,
      manifestSha256: preview.manifestSha256,
      preparedAt: now.getTime(),
      baseRevision: work.revision,
      eventId: null,
    });
    return {
      status: 201,
      body: {
        importId: preview.importId,
        manifestSha256: preview.manifestSha256,
        source: "import",
        evidenceKind: "imported",
        fileFormat: "docx",
        content: preview.content as PreviewContent,
        traces: [...preview.traces],
        rawByteLength: preview.rawByteLength,
        fileName: preview.fileName,
        baseRevision: work.revision,
        expiresAt: new Date(now.getTime() + IMPORT_PENDING_LIFETIME_MS).toISOString(),
      },
    };
  },
  "work.imports.confirm.post": ({ state, account, params, body, now }) => {
    if (account === null) return { error: "unauthorized" };
    if (body.importId !== params.importId) return { error: "invalid_input" };
    const work = state.works.find((w) => w.documentId === params.documentId);
    const prepared = importsOf(state).get(params.importId);
    if (
      work === undefined ||
      readerOf(state, work, account) !== "owner" ||
      prepared === undefined ||
      prepared.documentId !== work.documentId
    )
      return { error: "import_not_found" };
    const same = prepared.manifestSha256 === body.manifestSha256;
    if (prepared.eventId !== null) {
      if (!same) return { error: "import_manifest_mismatch" };
      return { status: 200, body: { importId: params.importId, eventId: prepared.eventId } };
    }
    if (!same) return { error: "import_manifest_mismatch" };
    const age = now.getTime() - prepared.preparedAt;
    if (age < 0 || age >= IMPORT_PENDING_LIFETIME_MS) return { error: "import_expired" };
    if (!takesImport(state, work)) return { error: "import_not_allowed" };
    if (work.revision !== prepared.baseRevision) return { error: "import_revision_changed" };
    prepared.eventId = randomUUID();
    return { status: 200, body: { importId: params.importId, eventId: prepared.eventId } };
  },
};
