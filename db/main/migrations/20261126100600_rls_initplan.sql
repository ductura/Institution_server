-- migrate:up
-- SRV-1411: both identity fields come from the same STABLE session lookup.
-- The uncorrelated row subquery makes them parameters of one InitPlan.
-- An anonymous session still matches neither of the NOT NULL row columns.
SET LOCAL ROLE ductus_evidence;

ALTER POLICY evidence_project_read ON evidence.project
  USING ((institution_id, principal_id) = (
    SELECT actor.institution_id, actor.user_id FROM app.current_actor() AS actor
  ));

ALTER POLICY evidence_document_read ON evidence.document
  USING ((institution_id, principal_id) = (
    SELECT actor.institution_id, actor.user_id FROM app.current_actor() AS actor
  ));

ALTER POLICY evidence_revision_read ON evidence.document_revision
  USING ((institution_id, principal_id) = (
    SELECT actor.institution_id, actor.user_id FROM app.current_actor() AS actor
  ));

ALTER POLICY evidence_package_read ON evidence.package
  USING ((institution_id, principal_id) = (
    SELECT actor.institution_id, actor.user_id FROM app.current_actor() AS actor
  ));

ALTER POLICY evidence_segment_read ON evidence.segment
  USING ((institution_id, principal_id) = (
    SELECT actor.institution_id, actor.user_id FROM app.current_actor() AS actor
  ));

ALTER POLICY evidence_receipt_read ON evidence.receipt
  USING ((institution_id, principal_id) = (
    SELECT actor.institution_id, actor.user_id FROM app.current_actor() AS actor
  ));

ALTER POLICY evidence_submission_request_read ON evidence.submission_request
  USING ((institution_id, principal_id) = (
    SELECT actor.institution_id, actor.user_id FROM app.current_actor() AS actor
  ));

ALTER POLICY evidence_submission_read ON evidence.submission
  USING ((institution_id, principal_id) = (
    SELECT actor.institution_id, actor.user_id FROM app.current_actor() AS actor
  ));

ALTER POLICY submission_receipt_issuance_read ON evidence.submission_receipt_issuance
  USING ((institution_id, principal_id) = (
    SELECT actor.institution_id, actor.user_id FROM app.current_actor() AS actor
  ));

SET LOCAL ROLE ductus_identity;

ALTER POLICY conversation_student_read ON assistant.conversation
  USING ((institution_id, student_id) = (
    SELECT actor.institution_id, actor.user_id FROM app.current_actor() AS actor
  ));

ALTER POLICY request_student_read ON assistant.request
  USING ((institution_id, student_id) = (
    SELECT actor.institution_id, actor.user_id FROM app.current_actor() AS actor
  ));

ALTER POLICY message_student_read ON assistant.message
  USING (conversation_id IN (
    SELECT c.id FROM assistant.conversation c
    WHERE (c.institution_id, c.student_id) = (
        SELECT actor.institution_id, actor.user_id FROM app.current_actor() AS actor
    )
  ));
RESET ROLE;

-- migrate:down
SET LOCAL ROLE ductus_evidence;

ALTER POLICY evidence_project_read ON evidence.project
  USING (institution_id = (SELECT app.current_institution_id())
    AND principal_id = (SELECT app.current_user_id()));

ALTER POLICY evidence_document_read ON evidence.document
  USING (institution_id = (SELECT app.current_institution_id())
    AND principal_id = (SELECT app.current_user_id()));

ALTER POLICY evidence_revision_read ON evidence.document_revision
  USING (institution_id = (SELECT app.current_institution_id())
    AND principal_id = (SELECT app.current_user_id()));

ALTER POLICY evidence_package_read ON evidence.package
  USING (institution_id = (SELECT app.current_institution_id())
    AND principal_id = (SELECT app.current_user_id()));

ALTER POLICY evidence_segment_read ON evidence.segment
  USING (institution_id = (SELECT app.current_institution_id())
    AND principal_id = (SELECT app.current_user_id()));

ALTER POLICY evidence_receipt_read ON evidence.receipt
  USING (institution_id = (SELECT app.current_institution_id())
    AND principal_id = (SELECT app.current_user_id()));

ALTER POLICY evidence_submission_request_read ON evidence.submission_request
  USING (institution_id = (SELECT app.current_institution_id())
    AND principal_id = (SELECT app.current_user_id()));

ALTER POLICY evidence_submission_read ON evidence.submission
  USING (institution_id = (SELECT app.current_institution_id())
    AND principal_id = (SELECT app.current_user_id()));

ALTER POLICY submission_receipt_issuance_read ON evidence.submission_receipt_issuance
  USING (institution_id = (SELECT app.current_institution_id())
    AND principal_id = (SELECT app.current_user_id()));

SET LOCAL ROLE ductus_identity;

ALTER POLICY conversation_student_read ON assistant.conversation
  USING (institution_id = (SELECT app.current_institution_id())
    AND student_id = (SELECT app.current_user_id()));

ALTER POLICY request_student_read ON assistant.request
  USING (institution_id = (SELECT app.current_institution_id())
    AND student_id = (SELECT app.current_user_id()));

ALTER POLICY message_student_read ON assistant.message
  USING (conversation_id IN (
    SELECT c.id FROM assistant.conversation c
    WHERE c.institution_id = (SELECT app.current_institution_id())
      AND c.student_id = (SELECT app.current_user_id())
  ));
RESET ROLE;
