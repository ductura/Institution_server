-- SRV-1304 (plan M10.2, M10.7): the dry run of the data classes,
-- app.retention_candidates(p_institution_id). It only reads: both functions
-- are STABLE, carry no write statement and leave every counted table as it
-- was. It sees only the institution of the session and answers only its
-- confirmed administrator. Personas of institution.inc (fak-a: Iva
-- administrator; fak-b: Lea administrator). Rows below are invented; the
-- evidence rows are written with foreign keys off (session_replication_role),
-- so only the counted columns matter.
BEGIN;
\ir fixtures/institution.inc
SET LOCAL lc_messages TO 'C';
SELECT no_plan();

-- Shape and privileges.
SELECT ok(p.prosecdef AND 'search_path=""' = ANY(p.proconfig), f || ': definer with an empty path')
  FROM unnest(ARRAY['app.retention_candidates(uuid)', 'app.retention_evidence_candidates(uuid)']) f
  JOIN pg_proc p ON p.oid = to_regprocedure(f);
SELECT is(p.provolatile, 's', f || ': STABLE, so PostgreSQL refuses any write inside it')
  FROM unnest(ARRAY['app.retention_candidates(uuid)', 'app.retention_evidence_candidates(uuid)']) f
  JOIN pg_proc p ON p.oid = to_regprocedure(f);
SELECT ok(lower(p.prosrc) !~ ('\m' || w || '\M'), f || ': no ' || w || ' statement')
  FROM unnest(ARRAY['app.retention_candidates(uuid)', 'app.retention_evidence_candidates(uuid)']) f
  JOIN pg_proc p ON p.oid = to_regprocedure(f)
  CROSS JOIN unnest(ARRAY['delete', 'update', 'insert', 'truncate', 'for update', 'for share']) w;
SELECT bag_eq(
  $$ SELECT r.rolname || ' ' || f
     FROM (SELECT rolname::text FROM pg_roles WHERE rolname LIKE 'ductus\_%' AND NOT rolcanlogin
           UNION ALL SELECT 'public') r
     CROSS JOIN unnest(ARRAY['app.retention_candidates(uuid)', 'app.retention_evidence_candidates(uuid)']) f
     WHERE has_function_privilege(r.rolname, f, 'EXECUTE')
       AND (SELECT proowner FROM pg_proc WHERE oid = to_regprocedure(f)) <> to_regrole(r.rolname) $$,
  ARRAY['ductus_app app.retention_candidates(uuid)', 'ductus_identity app.retention_evidence_candidates(uuid)'],
  'SRV-1304: only ductus_app runs the dry run, only the identity owner the evidence counts'
);
SELECT is(
  ARRAY(SELECT unnest(p.proargnames) FROM pg_proc p WHERE p.oid = 'app.retention_candidates(uuid)'::regprocedure),
  ARRAY['p_institution_id', 'class_key', 'candidates'],
  'SRV-1304: only a class and a count leave the function, never an identifier or a time'
);
SELECT is(pg_temp.ask('iva', 'SELECT count(*)::text FROM app.retention_evidence_candidates({fak_a})'),
  '42501: permission denied for function retention_evidence_candidates',
  'SRV-1304: the web role has no evidence counts');

-- Data. Sessions: two of fak-a ended more than 30 days ago (Ana closed, Marko
-- expired), one 29 days ago (Dora) stays; one old of fak-b (Tomo).
INSERT INTO identity.session (token_hash, user_id, institution_id, created_at, expires_at, last_seen_at, closed_at, close_reason)
SELECT sha256(convert_to('izmisljeni-182-' || s.name, 'UTF8')), pg_temp.id(s.person), p.institution_id,
       now() - s.age - interval '1 hour', now() - s.age + s.expiry, now() - s.age - interval '1 hour',
       CASE WHEN s.closed THEN now() - s.age END, CASE WHEN s.closed THEN 'logout' END
FROM (VALUES
  ('a-closed', 'ana', interval '31 days', interval '1 hour', true),
  ('a-expired', 'marko', interval '40 days', interval '0', false),
  ('a-recent', 'dora', interval '29 days', interval '1 hour', true),
  ('b-old', 'tomo', interval '35 days', interval '1 hour', true)
) AS s (name, person, age, expiry, closed)
JOIN person p ON p.name = s.person;

-- Access log: three rows of fak-a, one of fak-b.
INSERT INTO audit.access_log (institution_id, document_id, assignment_id, owner_id, reader_id, reader_role, surface, opened_at)
SELECT pg_temp.id(a.fak), 'izmisljeni-rad-' || a.owner, pg_temp.id(a.z), pg_temp.id(a.owner), pg_temp.id(a.reader),
       'teacher', 'live_view', date_bin('1 minute', now() - a.n * interval '1 day', timestamptz '2000-01-01 00:00:00+00')
FROM (VALUES ('fak_a', 'z1', 'ana', 'vesna', 1), ('fak_a', 'z1', 'ana', 'vesna', 2),
             ('fak_a', 'z1', 'dora', 'vesna', 3), ('fak_b', 'z3', 'tomo', 'petra', 1)) AS a (fak, z, owner, reader, n);

SET LOCAL session_replication_role = replica;
-- Works: Ana (fak-a) and Tomo (fak-b) submitted, Dora (fak-a) did not.
-- revisions: how many document revisions (0 .. n-1); checkpoints: at which
-- revisions; submitted: the submitted revision, or NULL.
CREATE TEMP TABLE work (who text, fak text, z text, revisions int, checkpoints int[], submitted int);
INSERT INTO work VALUES
  ('ana', 'fak_a', 'z1', 3, ARRAY[1, 2], 2),
  ('dora', 'fak_a', 'z1', 2, ARRAY[1], NULL),
  ('tomo', 'fak_b', 'z3', 2, ARRAY[1], 1);
INSERT INTO evidence.document_revision (document_id, institution_id, revision, base_revision, principal_id, content_hash)
SELECT 'izmisljeni-rad-' || w.who, pg_temp.id(w.fak), n, CASE WHEN n > 0 THEN n - 1 END, pg_temp.id(w.who), repeat('a', 64)
FROM work w CROSS JOIN LATERAL generate_series(0, w.revisions - 1) n;
INSERT INTO evidence.document_checkpoint (document_id, institution_id, revision, body, content_hash, created_at)
SELECT 'izmisljeni-rad-' || w.who, pg_temp.id(w.fak), c, 'Izmišljeni tekst.',
       encode(sha256(convert_to('Izmišljeni tekst.', 'UTF8')), 'hex'), now()
FROM work w CROSS JOIN LATERAL unnest(w.checkpoints) c;
INSERT INTO evidence.submission_request (id, institution_id, assignment_id, assignment_version, project_id,
  document_id, principal_id, revision, content_hash, requested_at)
SELECT md5('182-' || w.who)::uuid, pg_temp.id(w.fak), pg_temp.id(w.z), 1, 'izmisljeni-projekt-' || w.who,
       'izmisljeni-rad-' || w.who, pg_temp.id(w.who), w.submitted, repeat('a', 64), now() - interval '1 day'
FROM work w WHERE w.submitted IS NOT NULL;
INSERT INTO evidence.submission (submission_request_id, institution_id, principal_id, assignment_id,
  assignment_version, revision, artifact_hash, requested_at, due_at, recorded_at)
SELECT md5('182-' || w.who)::uuid, pg_temp.id(w.fak), pg_temp.id(w.who), pg_temp.id(w.z), 1, w.submitted,
       repeat('a', 64), now() - interval '1 day', now(), now() - interval '1 day'
FROM work w WHERE w.submitted IS NOT NULL;
-- Live view rows: every work has one; only the submitted ones are candidates.
INSERT INTO collaboration.live_state (document_id, institution_id, assignment_id, owner_id, body, content_hash, write_token)
SELECT 'izmisljeni-rad-' || w.who, pg_temp.id(w.fak), pg_temp.id(w.z), pg_temp.id(w.who), 'Izmišljeni tekst.',
       encode(sha256(convert_to('Izmišljeni tekst.', 'UTF8')), 'hex'), gen_random_uuid()
FROM work w;
SET LOCAL session_replication_role = DEFAULT;

CREATE TEMP TABLE before AS
SELECT t, (xpath('/row/c/text()', query_to_xml(format('SELECT count(*) AS c FROM %s', t), false, true, '')))[1]::text AS n
FROM unnest(ARRAY['identity.session', 'collaboration.live_state', 'audit.access_log', 'evidence.document_revision',
                  'evidence.document_checkpoint', 'evidence.submission', 'institution.institution_role']) t;

CREATE FUNCTION pg_temp.dry(p_actor text, p_fak text) RETURNS text
LANGUAGE sql AS $$
  SELECT pg_temp.ask(p_actor, format($q$ SELECT string_agg(class_key || '=' || coalesce(candidates::text, '-'), ' '
    ORDER BY class_key) FROM app.retention_candidates({%s}) $q$, p_fak))
$$;

-- The administrator of each institution sees the counts of their own.
SELECT is(pg_temp.dry('iva', 'fak_a'), 'access-log=3 change-times=- live-state=1 sessions=2 versions=3',
  'SRV-1304: Iva counts fak-a: 2 old sessions, 1 live row, 3 versions, 3 accesses, no change times');
SELECT is(pg_temp.dry('lea', 'fak_b'), 'access-log=1 change-times=- live-state=1 sessions=1 versions=1',
  'SRV-1304: Lea counts fak-b only');

-- Only the institution of the session: another one is ZD403, not its counts.
SELECT is(pg_temp.dry(c.actor, c.fak), 'ZD403: forbidden',
  format('SRV-1304: %s asks for %s: ZD403', c.actor, c.fak))
FROM (VALUES ('iva', 'fak_b'), ('lea', 'fak_a'), ('iva', 'nobody')) AS c (actor, fak);
SELECT is(pg_temp.ask('iva', 'SELECT count(*)::text FROM app.retention_candidates(NULL)'), 'ZD403: forbidden',
  'SRV-1304: no institution is ZD403');

-- Only the administrator: teachers, students and an unconfirmed teacher are 403.
SELECT is(pg_temp.dry(a, 'fak_a'), 'ZD403: forbidden', format('SRV-1304: %s is not an administrator: ZD403', a))
FROM unnest(ARRAY['vesna', 'marko', 'ana', 'dora', 'boris', 'nina']) a;
SELECT is(pg_temp.dry('tomo', 'fak_b'), 'ZD403: forbidden', 'SRV-1304: a student of fak-b: ZD403');

-- Without a live session: ZD401.
SELECT is(pg_temp.dry(a, 'fak_a'), 'ZD401: not authenticated', format('SRV-1304: %s: ZD401', a))
FROM unnest(ARRAY['anon', 'closed', 'expired', 'unknown']) a;

-- Nothing changed: every counted table has the rows it had.
SELECT is(
  (xpath('/row/c/text()', query_to_xml(format('SELECT count(*) AS c FROM %s', b.t), false, true, '')))[1]::text,
  b.n, 'SRV-1304: the dry run left ' || b.t || ' as it was')
FROM before b;

-- A revoked administrator is 403 at once.
SET LOCAL session_replication_role = replica;
UPDATE institution.institution_role SET revoked_at = now()
 WHERE user_id = pg_temp.id('iva') AND role = 'admin';
SET LOCAL session_replication_role = DEFAULT;
SELECT is(pg_temp.dry('iva', 'fak_a'), 'ZD403: forbidden', 'SRV-1304: a revoked administrator: ZD403');

SELECT * FROM finish();
ROLLBACK;
