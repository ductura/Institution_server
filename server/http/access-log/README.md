# HTTP za dnevnik pristupa radu

`GET /api/v1/works/{documentId}/access` (`work.access.get`, SRV-1706, plan M10.4, PRODUCT §5 pravilo 17) studentu pokazuje tko je i kada otvorio njegov rad: retke po 5 minuta grupirane po danu (Europe/Zagreb), najnoviji dan i redak prvi. Odgovor nema zbroj posjeta, trajanje ni broj po danu (D-274 MQ10).

Čita samo vlasnik rada. Tuđi, nepostojeći i neispravan rad daju isti 404 (C-23); bez sesije 401, `Sec-Fetch-Site` koji nije `same-origin` 403, a greška baze ili redak u koji čitanje ne može jamčiti 503. Kursor (`beforeAt`, `beforeId` iz `next`) vrijedi samo kao točno jedan od svakog; sve drugo čita prvu stranicu s `continued: false`. Čitač je u `server/database/access-log/`.
