# HTTP rute privitaka

- `POST /api/v1/student/assignments/{assignmentId}/attachments` prima JSON s `imageBase64` (PNG ili JPEG do 5 MiB). Vraća metapodatke privitka i `created`.
- `GET /api/v1/work-attachments/{attachmentId}` vraća metapodatke i `imageBase64`. Vlasnik rada i čitatelji kojima postojeći odnos daje pristup mogu čitati sliku.

`server/server.ts` montira obje rute preko `createAttachmentRoutesFor`. Pozivatelj iz odgovora za prijenos uzima `attachmentId` i `attachmentSha256` za blok slike v4. HTTP test pokreće stvarni router i datotečnu pohranu s probnim RPC odgovorima.

Servis prepoznaje PNG i JPEG iz strukture datoteke, bilježi prirodne dimenzije i SHA-256 te čuva izvorne bajtove. RPC-ovi SRV-10B utvrđuju ovlasti, ograničenja i ponovljeni prijenos. Pogreška pohrane prekida transakciju. Pri čitanju servis provjerava duljinu i SHA-256 bajtova.

Lokalni adapter koristi `.local/attachments` kada je `NODE_ENV` `development` ili `test`. Za druga okruženja treba postaviti `DUCTURA_ATTACHMENT_DIRECTORY` na apsolutnu putanju privatnog trajnog direktorija. Prekid između objave datoteke i potvrde transakcije može ostaviti datoteku bez retka u bazi.
