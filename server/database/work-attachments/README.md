# Privitci rada

Port privitaka rada studenta (SRV-10B; migracija `20261120233000_work_attachment.sql`): slike dokumenta. Blok slike u shemi v4 imenuje privitak s `attachmentId` i `attachmentSha256` (ugovor `docs/contracts/document-schema-v4.md` §5), a bajtovi slike nikad nisu u dokumentu. Redak privitka kaže kojem radu pripada (zadatak i student), vrstu datoteke (PNG ili JPEG), veličinu, SHA-256 točnih bajtova, prirodnu veličinu u pikselima (ako je poznata) i oznaku pohrane koju je adapter pohrane vratio.

## Što radi

`createWorkAttachments(withActor)` daje tri poziva, svaki u jednoj transakciji kroz RPC, nikad izravno u tablicu:

- `add(token, input)`: student rada bilježi privitak čije je bajtove poslužitelj već pohranio; isti bajtovi (isti SHA-256) u istom radu vraćaju postojeći redak (`created: false`), pa je ponovni pokušaj siguran;
- `list(token, assignmentId, studentId)`: privitci jednog rada redom upisa; `studentId` prazan za vlastiti rad, inače rad studenta kojemu je pozivatelj čitatelj (nositelj ili suradnik kolegija, nastavnik grupe, mentor);
- `read(token, attachmentId)`: jedan privitak po id-u, za put koji čita bajtove (prikaz, izvoz, rekonstrukcija); pripadnost radu provjerava se iz odnosa pozivatelja prema radu tog retka, nikad iz dokumenta (C-23).

Privitak se ne mijenja i ne briše (okidač u bazi): spremljena revizija dokumenta ga može imenovati. Granice: do 5 MiB po privitku, do 200 privitaka i 100 MiB po radu. Ishodi su vrijednosti, ne iznimke: ZD401 `unauthorized`, ZD403 `not_found` (jedan odgovor za svako odbijanje), ZD422 `invalid_input`; sve ostalo se baca. Spremljeni redak potvrđuje se unutar transakcije, pa pogrešan odgovor poništava upis. Testovi: `work-attachments.test.ts`; ovlasti i oblik u bazi pokrivaju `db/main/tests/030-institution-access-matrix.sql` (odjeljak 1g) i `156-work-attachment.sql`.

## Tko ga zove

Ruta privitaka rada (sljedeći korak, traka ugovora) preko `server/database/index.ts`: pohrani bajtove kroz adapter pohrane, izračuna SHA-256 i vrstu iz samih bajtova, pa zove `add`.

## Koje podatke dira

Tablicu `institution.work_attachment` glavne baze, samo kroz `institution.add_work_attachment`, `work_attachments` i `read_work_attachment`. Student i ustanova dolaze samo iz sesije.

## Što izvozi

`createWorkAttachments`, `isWorkAttachmentMediaType`, `WORK_ATTACHMENT_MAX_BYTES`, `WORK_ATTACHMENT_MEDIA_TYPES` i tipove `WorkAttachment`, `WorkAttachmentRecord`, `WorkAttachmentInput`, `WorkAttachmentAdd`, `WorkAttachmentList`, `WorkAttachmentRead`, `WorkAttachmentMediaType`, `WorkAttachments`.

## Što ne smije uvoziti

Ništa osim tipa `WithActor` iz `server/database` (karta servera).
