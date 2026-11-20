# server/http/source-proofs

Prilozi izvora preko HTTP-a (SRV-1102, Ductus#2051, val 11, editor E§3.4 „proofs”, B-8). Ugovor je `server/contracts/routes/source-proofs.ts`, port `server/database/source-proofs`, tablica i RPC-ovi su migracija `20261121130000_source_proof.sql` (`institution.source_proof`, `add_source_proof`, `source_proofs`, `read_source_proof_image`).

## Što radi

`createSourceProofRoutesFor({ withActor })` daje tri rute za studenta:

- `GET /api/v1/student/assignments/{assignmentId}/sources/{sourceId}/proofs`: prilozi jednog izvora vlastitog rada, najstariji prvi; `200 {proofs: [{id, page, note, imagePath}]}`.
- `POST` na isti put: multipart obrazac `{image, page, note?}`; `image` je datoteka (JPEG do 1 MiB), `page` i `note` su tekst. Vraća `201 {id, page, note, imagePath}`.
- `GET .../proofs/{proofId}/image`: bajtovi isječka, `200 image/jpeg` s `cache-control: private, no-store` i `x-content-type-options: nosniff`.

`imagePath` je put do treće rute; prilog se uvijek imenuje radom, izvorom i ID-om zajedno, pa ID drugog izvora ne otvara ništa.

## Odbijanja

- Bez žive sesije: 401. Tuđi rad, izvor koji nije u radu, nepoznat ili neispravan ID: 404 (jedan odgovor za svako odbijanje, C-23).
- `POST` bez `multipart/form-data` s ispravnom granicom: 415, prije čitanja tijela. Tijelo veće od ugovora: 413 (zaštita čitanja tijela i mutacija kao na ostalim rutama).
- Pokvaren obrazac, nepoznato polje, `image` koji nije datoteka, tekst koji nije UTF-8, stranica ili bilješka izvan ugovora, cijeli PDF ili bilo što što nije JPEG, rad na granici (200 priloga ili 100 MiB): 422. Provjera obrasca i JPEG-a ide prije baze.
- Obrazac piše svaki prijelom retka tekstnog polja kao CR LF; bilješka ga sprema kao LF.
- Neočekivana pogreška: 503. Samo uspješan `POST` broji aktivnost sesije.

Parser obrasca je `multipart.ts` (RFC 7578, samo ono što ruta treba).

## Testovi

`multipart.test.ts` (parser), `source-proofs.integration.test.ts` (stvarni poslužitelj i port nad lažnim `withActor`: ponovno čitanje veže prilog uz isti izvor i stranicu, PDF se odbija, tuđi rad je 404) i `tests/db/logout-old-cookie.integration.test.ts` (stara sesija nakon odjave dobiva 401 na sve tri rute, nad stvarnom bazom).
