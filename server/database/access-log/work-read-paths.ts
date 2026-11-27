// SRV-1706, plan M10.4-P02 (PRODUCT §5 rule 17, D-150, DAN-294): every path
// that returns the content of a work or its summary, and the row of
// audit.access_log each writes when someone other than the owner reads. The
// paths are the functions of the main database the web role (ductus_app) may
// execute and that reach a table holding the text of a work, directly or
// through a function they call; the HTTP side is each file of server/ that
// calls one of them.
//
// Two tests hold the list to the code:
// - work-read-paths.pg.integration.test.ts walks the migrated catalogue: the
//   functions that reach a content table are exactly those below, each of
//   WORK_READ_PATHS reaches the writer with its surfaces, and a teacher's read
//   writes the row while the owner's does not;
// - work-read-paths.test.ts checks that the callers in server/ are exactly
//   those named here, so a new adapter over a listed function is not missed.
// A new content read is either added to WORK_READ_PATHS with its row, or to
// NOT_A_PERSON_READ with the reason no person other than the owner reads text.

/** The surfaces audit.access_log allows (20261208100000). */
export type LoggedSurface =
  "live_view" | "process_summary" | "fast_path" | "replay" | "submitted_text" | "declaration";

export type WorkReadPath = {
  /** schema.name of the function the web role executes. */
  fn: string;
  returns: "content" | "summary";
  /** The surfaces the read writes. */
  surfaces: readonly LoggedSurface[];
  /** The pgTAP test that proves the row and the owner's silence. */
  proof: string;
  /** The files of server/ that call it (tests left out). */
  callers: readonly string[];
};

export type NotAPersonRead = {
  fn: string;
  why: "owner_only" | "write" | "no_content";
  note: string;
  callers: readonly string[];
};

export const WORK_READ_PATHS: readonly WorkReadPath[] = [
  {
    fn: "collaboration.read_live_state",
    returns: "content",
    surfaces: ["live_view", "submitted_text"],
    proof: "db/main/tests/122-access-log-reader-roles.sql",
    callers: [
      "server/collaboration/live-route.ts",
      "server/database/live-state.ts",
      "server/database/suggestions/suggestions.ts",
      "server/database/teacher-submitted-version/index.ts",
      "server/http/collaboration-comments/store.ts",
      "server/http/export/read-source.ts",
      "server/http/time-machine/store.ts",
    ],
  },
  {
    fn: "app.read_process_summary_source",
    returns: "summary",
    surfaces: ["process_summary"],
    proof: "db/main/tests/081-audit-access-log-write.sql",
    callers: ["server/projection/process-summary.ts"],
  },
  {
    fn: "app.fast_path_works",
    returns: "content",
    surfaces: ["fast_path"],
    proof: "db/main/tests/085-fast-path-works.sql",
    callers: [
      "server/database/submitted-works/submitted-works.ts",
      "server/downloads/merlin/files/source.ts",
      "server/teacher/fast-path.ts",
    ],
  },
  {
    fn: "app.read_replay_source",
    returns: "content",
    surfaces: ["replay"],
    proof: "db/main/tests/089-replay-source.sql",
    callers: ["server/database/replay-source.ts"],
  },
  {
    fn: "app.read_replay_checkpoints",
    returns: "content",
    surfaces: ["replay"],
    proof: "db/main/tests/089-replay-source.sql",
    callers: ["server/database/replay-source.ts", "server/http/time-machine/store.ts"],
  },
  {
    fn: "app.read_work_versions",
    returns: "content",
    surfaces: ["replay"],
    proof: "db/main/tests/152-work-versions.sql",
    callers: [
      "server/database/work-versions/work-versions.ts",
      "server/http/time-machine/store.ts",
    ],
  },
  {
    fn: "app.read_work_export",
    returns: "content",
    surfaces: ["replay"],
    proof: "db/main/tests/153-work-export.sql",
    // SRV-1312: the portable record reads the owner's own submitted text; no teacher, no log row.
    callers: [
      "server/database/portable-record/portable-record.ts",
      "server/database/work-export/work-export.ts",
    ],
  },
  {
    fn: "app.peer_review_work",
    returns: "content",
    surfaces: ["submitted_text"],
    proof: "db/main/tests/249-peer-review.sql",
    // SRV-V19-RECENZIJA-BAZA (OP-V19-6, provisional): the reviewer's reading of an author's
    // submitted text is logged with the real reader and the role peer_reviewer; the author's
    // log (read_my_access_log, the data export) shows that role and no identity.
    // SRV-V19-RECENZIJA-RUTE: the reviewer's work route reaches it through this adapter.
    callers: ["server/database/peer-review/index.ts"],
  },
  {
    fn: "app.teacher_declaration",
    returns: "content",
    surfaces: ["declaration"],
    proof: "db/main/tests/210-teacher-declaration-read.sql",
    // SRV-1213 (#580): the teacher's declaration read route reaches it through this adapter.
    callers: ["server/database/teacher-declaration/index.ts"],
  },
  {
    fn: "app.teacher_declaration_answer",
    returns: "content",
    surfaces: ["declaration"],
    proof: "db/main/tests/232-declaration-question.sql",
    // SRV-IZJAVA-PITANJE: the student's answer bound with the declaration, read in the same
    // transaction as app.teacher_declaration; the read writes the 'declaration' access-log row.
    callers: ["server/database/teacher-declaration/index.ts"],
  },
  {
    fn: "app.teacher_declaration_conversation",
    returns: "content",
    surfaces: ["declaration"],
    proof: "db/main/tests/261-teacher-declaration-conversation.sql",
    // F4-NAS-R04-SRV: the course teacher reads a conversation attached to the bound declaration,
    // up to its throughSeq; the read writes the 'declaration' access-log row.
    callers: ["server/database/teacher-declaration/conversation.ts"],
  },
];

export const NOT_A_PERSON_READ: readonly NotAPersonRead[] = [
  {
    fn: "app.open_student_work",
    why: "owner_only",
    note: "the owner opens their own work to write (principal_id = actor)",
    callers: ["server/database/open-work.ts", "server/database/student-work/start.ts"],
  },
  {
    fn: "app.read_own_reconstruction_checkpoint",
    why: "owner_only",
    note: "the owner's own earlier text in the time machine",
    callers: ["server/http/time-machine/store.ts"],
  },
  {
    fn: "app.read_submission_record",
    why: "owner_only",
    note: "the owner's own submission request (principal_id = actor)",
    callers: ["server/evidence/submission-record.ts"],
  },
  {
    fn: "declaration.read_statement",
    why: "owner_only",
    note: "the student's own declaration on their assignment",
    callers: ["server/database/statement/index.ts"],
  },
  {
    fn: "declaration.submission_gate",
    why: "owner_only",
    note: "PIL-K-IZJAVA-SRV: whether the owner's own declaration is confirmed for the revision they submit; one word, never text",
    callers: ["server/database/declaration/index.ts"],
  },
  {
    fn: "app.evidence_commit_context",
    why: "write",
    note: "the state the owner's next commit continues from (principal_id = actor)",
    callers: ["server/database/commit-context.ts"],
  },
  {
    fn: "app.commit_evidence_segment",
    why: "write",
    note: "the owner's commit of evidence (principal_id = actor)",
    callers: ["server/database/commit-evidence.ts"],
  },
  {
    fn: "app.prepare_submission_receipt",
    why: "write",
    note: "the receipt of the owner's own submission (principal_id = actor)",
    callers: ["server/evidence/submission-receipt.ts"],
  },
  {
    fn: "collaboration.publish_live_state",
    why: "write",
    note: "the owner publishes their live text; the answer is an outcome and a write token",
    callers: ["server/collaboration/live-route.ts", "server/database/live-state.ts"],
  },
  {
    fn: "declaration.save_statement",
    why: "write",
    note: "the student saves their own declaration; since SRV-IZJAVA-PITANJE only through save_statement_answer",
    callers: [],
  },
  {
    fn: "declaration.save_statement_answer",
    why: "write",
    note: "the student saves their own declaration and their own answer to the teacher's question",
    callers: ["server/database/statement/index.ts"],
  },
  {
    fn: "collaboration.publish_teacher_direct_edit",
    why: "no_content",
    note: "a teacher's direct edit; the answer is an outcome and a write token, never the text",
    callers: ["server/database/direct-edit/direct-edit.ts"],
  },
  // SRV-ED42-PRIJEDLOZI: a teacher's text suggestions (20261220190000).
  {
    fn: "collaboration.create_suggestion",
    why: "no_content",
    note: "a teacher's suggestion is bound to the hash of the live state; the answer is the new id, never the text",
    callers: ["server/database/suggestions/suggestions.ts"],
  },
  {
    fn: "collaboration.decide_suggestion",
    why: "owner_only",
    note: "only the student owner decides; accept answers the owner's own live state to apply the suggestion to",
    callers: ["server/database/suggestions/suggestions.ts"],
  },
  {
    fn: "collaboration.list_direct_edit_record",
    why: "no_content",
    note: "kinds, sources, modes, byte counts and five-minute times of direct edits, never text",
    callers: ["server/database/direct-edit/direct-edit.ts"],
  },
  {
    fn: "collaboration.rereview_revision_request",
    why: "no_content",
    note: "the state of a revision request (outcome, sequence, version, state)",
    callers: [
      "server/collaboration/revision-requests.ts",
      "server/http/revision-requests/store.ts",
    ],
  },
  {
    fn: "app.retention_candidates",
    why: "no_content",
    note: "the administrator's retention dry run (SRV-1304): one count per data class, never a text, an id or a time",
    callers: ["server/database/retention-dry-run/index.ts"],
  },
];
