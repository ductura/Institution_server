# WEB-8C `dorada-runde` (val 8, traka W-C)

Risk: medium. Samo sučelje; rukovatelj i ugovor roka su u SRV-8D.

## 1. Izvor

- PLAN-MIGRACIJE.md, „Val 8” (dorada s rokom, nova runda i povijest rundi, ✓ C-8).
- Prototip: `INVENTAR-nastavnik.md` §3.7 `rad` (dijalog `dd-h` „Zatraži doradu”, `doradaBanner` s četiri stanja, radnje „Prihvati doradu” i „Ponovno otvori”); `INVENTAR-editor.md` §2.5 mentor2 (`m2Back` „Vrati na doradu”, „Stanje rada”), §3.3 „Pošalji doradu na pregled” (`sendReview`) i „Dnevnik dorade”.
- Putanje: `src/components/teacher/revision/`, `src/components/editor/revision/`, `src/components/RevisionPanel`.

## 2. Ugovor rute

- Postoji: `collaboration.revision-requests.post`, `POST /api/v1/revision-requests/{action}`, `action` ∈ create, respond, accept, reopen, rereview, withdraw, list; `create` `{anchor, documentId, instruction, requestedRevision}` daje `{request_id, row_seq, version, state}`; 409 `conflict` nosi trenutno stanje; greške 401, 403, 404, 409, 415, 422, 503. Postoji i `collaboration.comments.post`.
- PRIJEDLOG (uvodi ga SRV-8D prvo): `dueAt` u `create`, `dueAt` i `round` u `list`. Povijest rundi i Dnevnik dorade nemaju rutu; PRIJEDLOG: čitaju se iz `list`, a zasebnu rutu uvodi serverski PR ako `list` ne nosi događaje.

## 3. Kriteriji prihvata

- [ ] Dijalog `dd-h`: prazno „Što treba doraditi” daje „Upišite što treba doraditi.”; rok je neobavezan i ne smije biti u prošlosti.
- [ ] Banner prikazuje sva četiri stanja; „Prihvati doradu” i „Ponovno otvori” šalju `accept` i `reopen` i prikazuju prethodno spremljeni toast tek nakon odgovora poslužitelja.
- [ ] Student: „Pošalji doradu” prikazuje što je promijenjeno i poruku mentoru; poruka „poslano” tek nakon odgovora 200 (B-6).
- [ ] 409 `conflict` osvježava stanje, bez ponovnog slanja istog tijela.
- [ ] Hrvatski tekstovi u `messages.hr`; skener zabranjenih izraza i pristupačnost (fokus u dijalogu) provjereni.
- [ ] Testovi s lažnim poslužiteljem za stanja i greške.

## 4. Ovisnosti

- SRV-8D (ugovor s rokom i rundom, pa rukovatelj) spojen; bump `@ductura/contracts` u webu (W-A). Bez toga `GOTOVO` bez PR-a.

## 5. Otvorena odluka: ODLUKA ORKESTRATORA

Dorada za cijeli rad nasuprot zahtjevu po mjestu u tekstu (`anchor`) i broji li se runda pri vraćanju ili pri slanju: SRV-8D.md, §5. Prototip pri vraćanju rundu ne povećava.
