# student-data-export

HTTP sloj izvoza podataka studenta (SRV-1308, nad SRV-1307): `GET` i `POST /api/v1/institution/student-data-exports`, `POST /api/v1/institution/student-data-exports/{exportId}/approve` i `GET /api/v1/student/data-export/{token}`. Pravila (zahtjev podnosi službenik referade koji nije administrator, odobrava administrator koji nije podnio zahtjev) odlučuje baza; ovdje su samo okvir zahtjeva i prijevod odgovora u problem+json.

Preuzimanje ne traži sesiju: pravo nosi sama poveznica. Poveznica se iskoristi i paket pročita u istoj transakciji, pa paket koji se ne može pročitati ostavlja poveznicu neiskorištenom (503). Drugi dohvat, istekla, nepoznata ili neispravna poveznica daju isti 410.

`storage.ts` je pohrana paketa po id-u izvoza (lokalno `.local/student-data-exports`, inače `DUCTURA_STUDENT_DATA_EXPORT_DIRECTORY`) i hash tokena poveznice; posao iz `server/privacy/student-data-export` piše kroz istu pohranu.
