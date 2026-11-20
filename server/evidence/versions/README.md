# Verzije rada

Odgovor rute `work.versions.get` (SRV-9A, Ductus#2028): popis verzija jednog rada, spremljene točke i predaja, najnovije prvo, stranicu po stranicu. Student rada i nastavnik zadatka dobivaju isti popis (Ductus `docs/PRODUCT.md` §5 pravila 5 i 7; ✓ C-10).

## Što radi

`answerWorkVersions(read, token, documentId, query)` provjerava zatvoren upit (samo jedan `beforeRevision`, znamenke bez vodeće nule, barem 2) prije baze, čita jednu stranicu kroz port `server/database/work-versions` i svaki ishod pretvara u status i tijelo ugovora: 200, 401, 404, 422 ili 503 s razlogom za zapis poslužitelja. Greška čitanja ide ruti, koja odgovara 503. `beforeRevisionOf` je provjera upita. Testovi: `work-versions.test.ts`.

## Tko ga zove

Ruta `server/http/work-versions.ts` preko `server/evidence/index.ts`.

## Koje podatke dira

Ništa izravno: samo port `createWorkVersionsReader` (funkcija `app.read_work_versions`). Pristup, presjek predajom i redak dnevnika pristupa nastavnika odlučuje baza; korisnik dolazi samo iz sesije.

## Što izvozi

`answerWorkVersions`, `beforeRevisionOf` i tip `WorkVersionsAnswer`.

## Što ne smije uvoziti

Ništa osim tipova iz `server/database` (karta servera: `evidence` smije `settings`, `log`, `metrics`, `domain`, `database`, `external/storage`).
