# HTTP za predložak rada na zadatku (SRV-V17-TEMPLATE-ASSIGN)

`createAssignmentTemplateRoutesFor` montira dvije rute nad portom `server/database/assignment-template`.

- `PUT /api/v1/teacher/assignments/{assignmentId}/template`: `{useInstitutionTemplate}`; nastavnik kolegija uključuje predložak (zamrzava zadnju verziju za vrstu rada zadatka; već zamrznuta ostaje) ili ga isključuje. Odgovor `{useInstitutionTemplate, version}`. Ustanova bez predloška za tu vrstu rada je 409.
- `GET /api/v1/student/assignments/{assignmentId}/template`: student kolegija čita `{version, titlePage, sections, citationStyle}`; zadatak bez predloška, tuđi, mentorski, nepoznat i neispravan id su isti 404 (C-23).

Test: `assignment-template.integration.test.ts`.
