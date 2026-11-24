# HTTP za predložak rada (SRV-V17-TEMPLATE-ADMIN)

`createWorkTemplateRoutesFor` montira dvije rute nad portom `server/database/work-template`.

- `GET /api/v1/institution/work-templates/{workType}`: administrator ustanove čita zadnju verziju (`current`, `null` dok je nema) i povijest te vrste rada.
- `PUT /api/v1/institution/work-templates/{workType}`: `{expectedVersion, titlePage, sections, citationStyle}` dodaje novu verziju (200); zastarjeli `expectedVersion` je 409, neispravan sadržaj ili nepoznata vrsta rada 422, nastavnik i student 403.

Ustanova i autor dolaze iz sesije, vrsta rada iz putanje, nikad iz tijela. Test: `work-template.integration.test.ts`.
