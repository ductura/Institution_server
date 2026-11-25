# server/domain/practice-journal

Dnevnik stručne prakse uz mentorstvo (val 19, SRV-V19-DNEVNIK-RUTE; ugovor [docs/contracts/practice-journal-v1.md](../../../docs/contracts/practice-journal-v1.md)). Samo čiste funkcije bez I/O-a.

- **Sažetak zapisa** (`entries-hash.ts`): `practiceEntriesSha256` je SHA-256 (mala heksadecimalna slova) JCS-a niza zapisa koje potpis pokriva, redom po datumu pa po redoslijedu dodavanja; svaki zapis je objekt `{correctsEntryId, date, entryId, hours, text}`. Isti bajtovi kao `institution.practice_entries_digest` u migraciji `20261219100000`; to dokazuje `server/http/practice-journal/practice-journal.pg.integration.test.ts`. `entriesThrough` bira zapise do datuma potpisa.
- **Provjera ulaza** (`validate.ts`): ono što obrazac ugovora ne može reći (datum koji postoji, redoslijed razdoblja, NFC, sati u koracima od 0,5). Ono što ovisi o danu i o praksi (datum nije u budućnosti, unutar razdoblja, najviše 400 zapisa) odlučuje baza.

Ništa ovdje ne ocjenjuje, ne rangira i ne sankcionira. Uvozi samo [`../forensics`](../forensics/README.md) (JCS) i `node:crypto`.
