-- migrate:up
-- SRV-F4-PM2-R18 step 2 (M8.10; ADR docs/adr/import-manifest-v2.md, accepted
-- by the owner on 27. 11. 2026, §4 item 2): the record of an import may hold
-- the file format odt. The column check of collaboration.import_event,
-- import_event_file_format_check, is replaced by one of the same name that
-- also allows 'odt'; every existing row (docx or pdf) stays valid.
--
-- Only the table changes. collaboration.prepare_import still prepares a
-- docx or pdf import alone and collaboration.is_import_manifest still takes
-- the v1 manifest alone, so no odt row can be written until the ODT reader
-- and the v2 manifest (step 3) change them. No other check or domain of the
-- import format exists in the schema.
SET LOCAL ROLE ductus_migrator;
SET LOCAL ROLE ductus_identity;

ALTER TABLE collaboration.import_event
  DROP CONSTRAINT import_event_file_format_check,
  ADD CONSTRAINT import_event_file_format_check CHECK (file_format IN ('docx', 'pdf', 'odt'));

-- migrate:down
-- Local only; staging and production only go forward (docs/BACKEND.md §6).
-- Fails while an odt row exists: the record is append only.
SET LOCAL ROLE ductus_migrator;
SET LOCAL ROLE ductus_identity;
ALTER TABLE collaboration.import_event
  DROP CONSTRAINT import_event_file_format_check,
  ADD CONSTRAINT import_event_file_format_check CHECK (file_format IN ('docx', 'pdf'));
