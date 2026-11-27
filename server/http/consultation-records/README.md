# server/http/consultation-records

Postavlja tri rute zajedničkog zapisa konzultacije o radu (SRV-1105, Ductus#2051; N-12, D-47, PO-22):

- `GET /api/v1/works/{documentId}/consultation-records` vraća `200 {records}`;
- `POST` na isti put prima `{heldOn, revision, topic, agreement}` i, po izboru, `heldAt` (vrijeme održavanja, ISO UTC; F4 val 2 #2) i vraća `201` zapis;
- `POST .../{recordId}/additions` prima `{text}` i vraća `201 {id, text, createdAt}`.

Kolačić određuje sesiju (401). Rad koji nije rad sesije, ne postoji ili je neispravan, i zapis koji nije taj rad, su isti 404 (C-23). Prazna tema ili dopuna, nepostojeći datum i revizija drugog rada su 422. Student i nastavnik zadatka čitaju isti popis, pa student nakon učitavanja vidi dopunu nastavnika. Podaci idu samo kroz `server/database/consultation-records`.
