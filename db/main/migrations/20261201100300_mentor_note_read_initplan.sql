-- mentor_note_read (20261126100700) called institution.actor_mentorship_role
-- once per row, which 118-actor-scope-initplan forbids for every policy but
-- work_accommodation_read. The same rule, read without a per-row function:
-- the caller is the note's mentor, holds the confirmed teacher role, and the
-- note's mentorship is theirs and not ended (actor_mentorship_role 'teacher').
ALTER POLICY mentor_note_read ON institution.mentor_note
  USING (institution_id = (SELECT app.current_institution_id())
         AND mentor_id = (SELECT app.current_user_id())
         AND (SELECT institution.actor_has_role('teacher'))
         AND EXISTS (
           SELECT 1
           FROM institution.mentorship m
           WHERE m.id = mentor_note.mentorship_id
             AND m.institution_id = mentor_note.institution_id
             AND m.mentor_id = (SELECT app.current_user_id())
             AND m.ended_at IS NULL));
