# Izvoz upitnika v1

Zadatak: SRV-V18-UPITNIK-IZVOZ `srv-v18-upitnik-izvoz` (Ductus#2058, nalog c.7173573927; val 18, `docs/nalazi/val18-razlika.md` §3 V18-1, V18-4, V18-6, §5 zadatak 4). Status: **aditivno, unatrag kompatibilno** (API minor s ovom rutom: 1.150.0; jedna nova ruta, bez novih kodova grešaka). Ovisi o SRV-V18-UPITNIK-ISPUNJAVANJE (granano iz njegove grane) i o SRV-V18-UPITNIK-BAZA (migracija `20261219380000_questionnaire.sql`, adapter `createQuestionnaireStore`, domena `buildQuestionnaireExport`).

## Načela

- **Izvoz je samo priprema za val 15.** Ne postoji statistički servis i ništa se nikamo ne šalje (V18-5). Ruta samo vraća JSON; CSV gradi web iz tog JSON-a (V18-6).
- **Redak nema osobu ni vrijeme.** Redak je jedan list. `n` je položaj lista u poretku po sažetku (SHA-256) slučajnog identifikatora lista, nikad po vremenu dolaska (V18-1). Isti listovi daju iste bajtove (ponovljivost, plan val 15).
- **Najmanji broj listova.** Ispod `QUESTIONNAIRE_EXPORT_MIN_RESPONSES` (5, pretpostavka OP-V18-4; vrijednost potvrđuje vlasnik) odgovor je 409 `conflict` i ne vraća ništa, jer bi tanak izvoz upirao u osobu.
- **Slobodni tekst je izvan izvoza** dok autor izričito ne zatraži `includeText=true` (može identificirati).
- Nikad ocjena, rang, zbroj bodova ni usporedba osoba. Pristup iz odnosa (C-23): nastavnik kolegija; student, nastavnik drugog kolegija, nepoznat i neispravan id isti su 404. Ruta ne zove pomoćnika.
- Samo izmišljeni podaci u testovima (`demo-*`); stvarni ispitanici tek po DPIA-i (OP-V18-1).

## Ruta

| Operacija                          | Ruta                                             | Pristup          |
| ---------------------------------- | ------------------------------------------------ | ---------------- |
| `teacher.questionnaire-export.get` | `GET /api/v1/teacher/questionnaires/{id}/export` | `course_teacher` |

```
GET /teacher/questionnaires/{id}/export[?includeText=true|false]
-> 200 { schema: "questionnaire-export-v1", questionnaireId,
         variables: [{ questionId, order, kind, label, options: [{code, label}] }],
         rows: [{ n, values: { <questionId>: vrijednost | null } }],
         responseCount, includesText }
```

- `variables` su pitanja po redoslijedu autora; `options` je prazan niz za pitanja bez opcija. Pitanja vrste `text` su izostavljena (`includesText: false`) osim uz `includeText=true`.
- Vrijednosti kao u ispunjavanju: `single` kod opcije, `multiple` niz kodova, `scale` cijeli broj, `number` broj, `text` tekst; `null` = list nema odgovora na to pitanje.
- Upit: samo `includeText` s točno `true` ili `false`, jednom. Svaka druga vrijednost ili drugi parametar je 422 `invalid_input`, prije baze.
- Ostale greške: 401 `unauthorized`, 403 (zaštita istog podrijetla), 404 `not_found`, 409 `conflict` (premalo listova), 503 `unavailable`. Odgovor se provjerava prema ugovoru; izvoz izvan ugovora (osoba uz redak, manje od 5 listova) je 503 i ne šalje se. Odgovor je `cache-control: no-store`.

## Pretpostavke

- **Zapisnik pristupa nije napravljen.** Zadatak traži da se izvoz bilježi u zapisnik pristupa autora. Tablica `audit.access_log` zahtijeva `reader_id <> owner_id`, zatvoren popis površina i dokument rada, pa bi bilježenje tražilo novu migraciju (promjena sheme), koja nije na popisu putanja ovog zadatka. Po pravilu „Izvan opsega” taj dio se izdvaja u zaseban zadatak; otvorena stavka u opisu PR-a.
- „Kod iz kataloga” za premalo listova je postojeći `conflict` (409); novi kod greške na ruti bio bi nova verzija ugovora.
- Poredak po sažetku identifikatora lista već daje domena (`server/domain/questionnaire/export.ts`); ruta ga ne mijenja.
- `includeText=true` ne traži dodatnu potvrdu na poslužitelju; potvrdu autora vodi web (WEB-V18-UPITNIK-IZVOZ).

## Primjer (izmišljen)

```
GET /api/v1/teacher/questionnaires/00000000-0000-4000-8000-0000000000b1/export
-> 200 { "schema": "questionnaire-export-v1",
         "questionnaireId": "00000000-0000-4000-8000-0000000000b1",
         "variables": [ { "questionId": "00000000-0000-4000-8000-0000000000f1", "order": 1,
                          "kind": "single", "label": "Kompostirate li kod kuće?",
                          "options": [ { "code": "da", "label": "Da" }, { "code": "ne", "label": "Ne" } ] } ],
         "rows": [ { "n": 1, "values": { "00000000-0000-4000-8000-0000000000f1": "da" } }, … ],
         "responseCount": 5, "includesText": false }
```

## Testovi

`server/http/questionnaire-export.integration.test.ts` (upit izvan ugovora, neispravan id, 401, 403, premalo listova, preslikavanje grešaka baze, izvoz izvan ugovora), vektori `server/contracts/vectors/teacher.questionnaire-export.get.json`, lažni dev server `packages/test-fakes/dev-server/questionnaire-routes.ts`, `tests/db/logout-old-cookie.integration.test.ts` (404 za nepostojeći upitnik), poredak i prag u `server/domain/questionnaire/questionnaire.test.ts` i adapter `server/database/questionnaire/questionnaire.test.ts` (SRV-V18-UPITNIK-BAZA).
