# HTTP za predložak etapa (SRV-1521)

`createMilestoneTemplateRoutesFor` montira pet ruta nad portom `server/database/milestone-template`.

- `GET /api/v1/institution/milestone-template`: administrator ustanove čita zadnju verziju (`current`, `null` dok je nema) i povijest.
- `PUT /api/v1/institution/milestone-template`: `{expectedVersion, requireFinalStageApproval, milestones}` dodaje novu verziju (200); zastarjeli `expectedVersion` je 409, neispravan popis 422, nastavnik i student 403. Radovi koji već imaju etape ih zadržavaju.
- `GET /api/v1/works/{documentId}/milestone-plan`: plan etapa rada (naslov, rok, što se šalje) za studenta vlasnika i nastavnike; student vidi isto što i mentor.
- `POST /api/v1/works/{documentId}/milestone-plan/milestones` `{title, dueAt?, submits}` (mentor): dodaje etapu na kraj (201, cijeli plan); 409 nakon konačne predaje ili preko 100 etapa.
- `POST /api/v1/works/{documentId}/milestone-plan/apply-template` (mentor, bez tijela): zamjenjuje etape zadnjim predloškom (200); 409 kad je neka etapa ikad poslana, nakon konačne predaje i dok predloška nema.

Ustanova, autor i dokument dolaze iz sesije i putanje, nikad iz tijela. Test: `milestone-template.integration.test.ts`.
