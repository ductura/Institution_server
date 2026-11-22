# HTTP za etape rada

`GET /api/v1/works/{documentId}/milestones` vraća popis etapa vlasniku i ovlaštenom nastavniku. `PATCH /api/v1/works/{documentId}/milestones/{milestoneId}` prima `{dueAt}` i vraća ažuriranu etapu. Vrijeme se u odgovoru prikazuje u UTC-u. Tuđi i nepostojeći rad vraćaju 404. Student za pokušaj izmjene vlastitog rada dobiva 403. Nakon konačne predaje nastavnik dobiva 409.

`createWorkMilestonesRoutesFor` montira oba rukovatelja. Test prolazi kroz HTTP i pozive adaptera uz simuliranu bazu.

## Stanja etapa (SRV-1520)

Stanja `not_submitted`, `submitted`, `revision_requested`, `approved` vraćaju nove rute; `GET .../milestones` i `PATCH .../milestones/{milestoneId}` ostaju kakvi jesu (ugovor `/api/v1` se ne lomi).

- `GET /works/{documentId}/milestone-states`: etape rada sa stanjem, datumima i zatraženom dorada; student vidi isto što i nastavnik.
- `POST .../milestones/{milestoneId}/submit` (student vlasnik, bez tijela): zamrzava reviziju rada (`submittedRevisionId`), iz `not_submitted` ili `revision_requested`.
- `POST .../request-revision` (mentor) `{comment, revisionDueAt?}` i `POST .../approve` (mentor) `{message?}`, samo iz `submitted`.
- `PATCH .../milestones/{milestoneId}/details` `{title?, dueAt?}`: i nakon slanja; naziv samo na zadatku mentorstva, inače 409.
- `DELETE .../milestones/{milestoneId}`: 204; etapa koja je ikad poslana vraća 409.

Rokovi (etape i dorade) su podsjetnik: nijedna ruta ne zaključava pisanje ni predaju. Svaki prijelaz je događaj u `institution.work_milestone_event` (samo dodavanje).
