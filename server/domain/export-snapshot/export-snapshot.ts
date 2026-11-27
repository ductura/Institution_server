import { createHash } from "node:crypto";
import type { CanonicalDocumentV4, DocumentNodeV4, InlineNodeV4 } from "../document/index.ts";
import { canonicalizeJcs } from "../forensics/index.ts";

export type ExportCapability = "exported" | "degraded" | "omitted";

export type PageSetup = {
  readonly widthTwips: number;
  readonly heightTwips: number;
  readonly marginTwips: number;
};

export type ExportCover = {
  readonly institution: string;
  readonly unit: string;
  readonly workType: string;
  readonly student: string;
  readonly mentor: string;
  readonly study?: string;
  readonly place?: string;
  readonly date?: string;
};

export type ExportSnapshotInput = {
  document: CanonicalDocumentV4;
  versionId: string;
  kind: "saved" | "submitted";
  pageSetup: PageSetup;
  cover: ExportCover;
  expiresAt: string;
};

type ExportNode = DocumentNodeV4 | InlineNodeV4;
type CapabilityMap = Record<Exclude<ExportNode["type"], "orderedItem">, ExportCapability> &
  Partial<Record<string, ExportCapability>>;

type DeepReadonly<T> = T extends string ? T : { readonly [Key in keyof T]: DeepReadonly<T[Key]> };

type SnapshotPayload = ExportSnapshotInput & { capabilityMap: CapabilityMap };

export type ExportSnapshot = DeepReadonly<SnapshotPayload> & {
  readonly canonicalJson: string;
  readonly sha256: string;
};

// DOCX capabilities by node kind. Inline marks and source records are not nodes.
const DOCX_CAPABILITIES = {
  paragraph: "exported",
  heading: "exported",
  bulletItem: "degraded",
  orderedItem: "degraded",
  quote: "exported",
  codeBlock: "degraded",
  box: "degraded",
  formula: "degraded",
  pageBreak: "exported",
  table: "omitted",
  image: "omitted",
  text: "exported",
  inlineFormula: "degraded",
  citation: "omitted",
  footnote: "omitted",
  crossReference: "omitted",
} satisfies Record<ExportNode["type"], ExportCapability>;

// `orderedItem` (v4 §2.2) is listed only for a document that has one, so the
// frozen bytes and hash of every export without a numbered list stay as they were.
const { orderedItem: ORDERED_ITEM_CAPABILITY, ...BASE_CAPABILITIES } = DOCX_CAPABILITIES;

function capabilityMapFor(nodes: readonly DocumentNodeV4[]): CapabilityMap {
  const unknownTypes = new Set<string>();
  let hasOrderedItem = false;
  let hasTable = false;
  let hasImage = false;
  const pending: unknown[] = [...nodes];
  const visited = new WeakSet<object>();
  while (pending.length > 0) {
    const node = pending.pop();
    if (node === null || typeof node !== "object" || visited.has(node)) continue;
    visited.add(node);
    if ("type" in node && node.type === "orderedItem") hasOrderedItem = true;
    if ("type" in node && node.type === "table") hasTable = true;
    if ("type" in node && node.type === "image") hasImage = true;
    if (
      "type" in node &&
      typeof node.type === "string" &&
      !Object.hasOwn(DOCX_CAPABILITIES, node.type)
    ) {
      unknownTypes.add(node.type);
    }
    if ("children" in node && Array.isArray(node.children)) {
      for (const child of node.children) pending.push(child);
    }
  }
  return {
    ...BASE_CAPABILITIES,
    ...(hasOrderedItem ? { orderedItem: ORDERED_ITEM_CAPABILITY } : {}),
    // The writer prints tables and images (SRV-10D). Like the numbered list, the new value
    // applies only to a work that has the node, so the fingerprint of every other export is
    // what it was. An image without usable bytes is printed as unavailable, hence degraded.
    ...(hasTable ? { table: "exported" as const } : {}),
    ...(hasImage ? { image: "degraded" as const } : {}),
    ...Object.fromEntries([...unknownTypes].map((type) => [type, "omitted"] as const)),
  };
}

function freezeJson(value: unknown): void {
  if (value === null || typeof value !== "object") return;
  for (const child of Object.values(value)) freezeJson(child);
  Object.freeze(value);
}

/** Capture an already selected revision and the export parameters as plain JSON. */
export function freezeExportSnapshot({
  document,
  versionId,
  kind,
  pageSetup,
  cover,
  expiresAt,
}: ExportSnapshotInput): ExportSnapshot {
  const canonicalJson = canonicalizeJcs({
    document,
    versionId,
    kind,
    pageSetup,
    cover,
    expiresAt,
    capabilityMap: capabilityMapFor(document.nodes),
  } satisfies SnapshotPayload);
  // Decode our own JSON to detach the snapshot from every caller-owned object.
  const payload = JSON.parse(canonicalJson) as SnapshotPayload;
  const sha256 = createHash("sha256").update(canonicalJson, "utf8").digest("hex");
  const snapshot = { ...payload, canonicalJson, sha256 };
  freezeJson(snapshot);
  return snapshot;
}
