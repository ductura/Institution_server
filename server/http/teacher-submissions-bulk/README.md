# Skupno preuzimanje predaja

`POST /api/v1/teacher/assignments/{assignmentId}/submissions-bulk-link` i `GET /api/v1/teacher/assignments/{assignmentId}/submissions-bulk/{format}` (`teacher.submissions-bulk-link.post`, `teacher.submissions-bulk.get`; SRV-1902, plan P-D2): nastavnik zadatka traži poveznicu od 24 sata i kroz nju preuzima ZIP svih predaja tog zadatka.

## Što radi

- `link.ts`: poveznica nosi vlastiti istek i MAC (HMAC-SHA256) nad zadatkom, formatom i istekom, s ključem sesije koja ju je tražila (kao poveznica paketa iz SRV-1807, s vlastitom oznakom). Ne može se prenijeti na drugi zadatak, format ni sesiju, a istek se ne može produljiti. Nije ovlast za čitanje: preuzimanje i dalje traži živu sesiju i nastavnika zadatka.
- `build.ts`: iz popisa za Merlin (SRV-1109) uzima samo datoteke odabranog formata, svaku provjerava otiskom iz njezina retka, uz nju stavlja PDF potvrde predaje istog studenta (`<naziv>-potvrda.pdf`) i dodaje `otisci.sha256`. Student bez predaje nema datoteku; potvrda koja čeka potpis nije u ZIP-u. Isti ulaz daje iste bajtove.
- `index.ts`: HTTP rub i sastav postojećih čitanja. Poveznica provjerava pristup čitanjem produljenja roka (SRV-1108: samo nastavnik zadatka, inače `not_found`), bez čitanja rada i bez zapisa. Preuzimanje čita radove kroz `app.fast_path_works` (isto čitanje kao brzi put i paket za Merlin), koje u istoj transakciji upisuje nastavnikovo otvaranje svakog predanog teksta u dnevnik pristupa (SRV-11), pa je svako preuzimanje zapisano. Potvrde čita `app.teacher_submission_state` (SRV-30) i provjerava kao za studenta.

Odgovori: bez sesije 401, `Sec-Fetch-Site` koji nije `same-origin` 403, tuđi, nepoznat i neispravan zadatak te poveznica druge sesije, zadatka ili formata isti 404 (C-23), istekla poveznica 410. Čitanja koja se ne slažu (potvrda drugog studenta, predaja bez stanja), nedostatak `APP_ORIGIN` za QR potvrde ili iznimka daju 503 sa zatvorenim razlogom, nikad djelomičan ZIP.

## Otvorene stavke

- Gradnja je u zahtjevu: radnik (`server/worker`) još nema proces, a granice područja (docs/server-map.md §2) ne dopuštaju radniku uvoz `downloads` ni webu uvoz `worker`.
- Otvaranje se u dnevnik upisuje s površinom `fast_path`; zasebna površina za skupno preuzimanje traži migraciju (traka S-B).
- Prozor brzog puta drži reviziju 5 minuta: predaja nakon otvaranja prozora daje 503 dok prozor ne istekne (kao paket za Merlin).
