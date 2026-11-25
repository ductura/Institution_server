# server/domain/questionnaire

Upitnik kolegija (SRV-V18-UPITNIK-BAZA, val 18). Samo čiste funkcije bez I/O-a; iste su granice kao u migraciji `20261219380000_questionnaire.sql`, koja je mjerodavna.

- **Definicija** (`definition.ts`): pet vrsta pitanja (`single`, `multiple`, `scale`, `number`, `text`), granice duljina, opcije (kod i oznaka), ljestvica, stanja `draft` → `open` → `closed` bez povratka.
- **Odgovori** (`answers.ts`): je li vrijednost odgovor na pitanje svoje vrste i je li list odgovora valjan (najviše jedan po pitanju, samo pitanja upitnika). Pitanje bez odgovora je pitanje na koje se nije odgovorilo.
- **Izvoz** (`export.ts`): oblik `questionnaire-export-v1`. Isti ulaz daje iste bajtove. Retci nemaju osobu ni vrijeme i idu redom sažetka identifikatora lista, ne redom pristizanja. Slobodni tekst ulazi samo uz izričit pristanak. Ispod `QUESTIONNAIRE_EXPORT_MIN_RESPONSES` (5, vrijednost potvrđuje vlasnik, OP-V18-4) izvoza nema. Ništa se ne zbraja ni rangira po osobi.

Uvozi samo `node:crypto`. Testovi: `questionnaire.test.ts`.
