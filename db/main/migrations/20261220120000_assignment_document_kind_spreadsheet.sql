-- migrate:up
-- SRV-V14-KIND (Ductus#2058, order of 25. 11. 2026; WEB docs/nalazi/
-- val14-razlika.md, task 1). The kind of document of an assignment and of its
-- work gains the value 'spreadsheet': 'text' | 'slides' | 'spreadsheet'.
-- Only the CHECK of the two columns of SRV-V13-MIG-VRSTA changes; both
-- columns keep NOT NULL DEFAULT 'text', so every existing row is untouched.
-- No new table, no new function, no grant change: the columns still follow
-- the row security of their tables, the application role still only reads
-- institution.assignment.document_kind and cannot write the work's.
--
-- Assumption: nothing makes a spreadsheet assignment or work yet.
-- app.open_student_work answers 'not_configured' for any kind but text (the
-- revision 0 of a spreadsheet is a later task), so the new value cannot be
-- reached through a route; it is only allowed by the CHECK.
SET LOCAL ROLE ductus_identity;
ALTER TABLE institution.assignment DROP CONSTRAINT assignment_document_kind_check;
ALTER TABLE institution.assignment ADD CONSTRAINT assignment_document_kind_check
  CHECK (document_kind IN ('text', 'slides', 'spreadsheet'));

SET LOCAL ROLE ductus_evidence;
ALTER TABLE evidence.document DROP CONSTRAINT document_document_kind_check;
ALTER TABLE evidence.document ADD CONSTRAINT document_document_kind_check
  CHECK (document_kind IN ('text', 'slides', 'spreadsheet'));
RESET ROLE;

-- migrate:down
-- Local only: staging and production migrate forward (docs/BACKEND.md 6).
SELECT 1;
