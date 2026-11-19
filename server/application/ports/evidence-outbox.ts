import type {
  EvidenceIngestCommandV2,
  EvidenceIngestOutcome,
  SignedEvidenceReceipt,
} from "./evidence-ingest.ts";

export type EvidenceOutboxStatus = "pending" | "uploading" | "accepted" | "blocked";

export type EvidenceOutboxItem = {
  id: string;
  command: EvidenceIngestCommandV2;
  status: EvidenceOutboxStatus;
  attempts: number;
  createdAt: string;
  updatedAt: string;
  // exactOptionalPropertyTypes: a transition sets it to undefined explicitly.
  lastFailure?: EvidenceIngestOutcome["status"] | undefined;
  receipt?: SignedEvidenceReceipt;
};

export interface EvidenceOutboxStore {
  put(item: EvidenceOutboxItem): Promise<void>;
  get(id: string): Promise<EvidenceOutboxItem | null>;
  listPending(limit: number): Promise<readonly EvidenceOutboxItem[]>;
}
