# WEB-9B `usporedba-verzija-pregled` (val 9, traka W-C)

Risk: medium. Samo sučelje; podaci kroz `/api/v1`, komponente iz `@ductura/ui`, smjer „papir i grafit”.

## 1. Izvor

- PLAN-MIGRACIJE.md, „Val 9” (N-11, ✓ C-10) i „UI prvo: prikaz razlika”.
- Prototip: `INVENTAR-nastavnik.md` §3.11 `usporedba` (N-11; select `#f-cmp`, „Dodano n / Uklonjeno m riječi”, ins/del s tekstom „dodano:” i „uklonjeno:” za čitače zaslona; stanja puno, prazno, učitavanje, greška) i `Ductura_nastavnik.html`; `INVENTAR-editor.md` §3.5 mentor3 „Usporedi predaje” (`m3hist`, najviše 8 točaka, „Samo promjene”).
- Postoji: `src/domain/diff`, `packages/editor-core/.../diff`, `@ductura/ui` `DiffView` (UI-9A).
- Putanje: `src/components/teacher/compare/`, `src/components/editor/diff/`.

## 2. Ugovor rute

- `work.versions.get`, `GET /api/v1/works/{documentId}/versions` (postoji, SRV-9A #458): `versions:[{kind:"checkpoint"|"submission", revision, savedMinute, afterDeadline?}]`, `nextBeforeRevision`; greške 401, 404, 422, 503. Bez teksta, otiska i veličine promjene.
- `work.compare.get`, `GET /api/v1/works/{documentId}/compare?from&to`: PRIJEDLOG iz SRV-9E.md; ne postoji dok ga ne uvede serverski PR i bump ugovora u webu (traka W-A, `src/client`).

## 3. Kriteriji prihvata

- [ ] Select „Od” i „Do” puni se iz popisa verzija; ista točka dvaput daje poruku „Odabrali ste istu točku dvaput.”, bez poziva rute.
- [ ] Brojke i razlika dolaze s poslužitelja; klijent ne računa razliku iz teksta.
- [ ] Svaka umetnuta i uklonjena riječ ima tekstnu oznaku, ne samo boju (WCAG 2.2 AA).
- [ ] Stanja prazno (jedna verzija, poveznica na reprodukciju), učitavanje, greška i 404 imaju hrvatske poruke u `messages.hr`.
- [ ] Nema postotaka, ocjene ni međustanja (§5 pravila 2 i 7); skener zabranjenih izraza zelen.
- [ ] Test s lažnim poslužiteljem za puno, prazno, grešku i `truncated`.

## 4. Ovisnosti

- SRV-9A spojen (#458). SRV-9E (ugovor `work.compare.get`) i bump `@ductura/contracts` u webu moraju biti spojeni; do tada pisac završava s `GOTOVO` bez PR-a.

## 5. Otvorena odluka: ODLUKA ORKESTRATORA

Smiju li „Od” i „Do” biti spremljene točke ili samo predaje: ista odluka kao u SRV-9E.md, §5. Sučelje nudi onoliko točaka koliko ruta dopušta.
