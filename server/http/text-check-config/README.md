# server/http/text-check-config

`GET /api/v1/student/assignments/{assignmentId}/text-check-config` (`student.text-check-config.get`, SRV-1101, Ductus#2051). Bez tijela; vraća `{enabledCheckIds, lektaProfileId, citationStyle}`: profil je `null` kad ga ustanova nije postavila, a `citationStyle` je stil citiranja ustanove (`fpzg` kad ga nije postavila ili je pohranjena vrijednost izvan kataloga).

- Jedna `withActor` transakcija (`server/database/settings/text-check-config.ts`): zadatak mora biti u `app.student_workspace()` (isti pristup kao rad), zatim `settings.read_institution_values()` (SRV-7E; student vidi samo `lekta.profile` i `citation.style`). Zadatak izvan radnog prostora, nepoznat ili neispravan id: 404. Sadržaj rada se ne čita ni ne vraća.
- Identifikatori provjera i pravilo „što je uključeno” su u `server/domain/settings/text-check-rules.ts`: identifikatori su vrste iz prototipa editora; bez profila vrijede zadane vrijednosti prototipa, a s profilom se dodaju `colloq`, `absolute` i `first`. Sadržaj paketa pravila ostaje u Danielovu službenom paketu kad bude dostupan.
- Test: `text-check-config.integration.test.ts` (dvije izmišljene ustanove).
