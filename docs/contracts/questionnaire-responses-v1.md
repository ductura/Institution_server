# Ispunjavanje upitnika v1

Zadatak: SRV-V18-UPITNIK-ISPUNJAVANJE `srv-v18-upitnik-ispunjavanje` (Ductus#2058, nalog c.7173075839; val 18, `docs/nalazi/val18-razlika.md` §3 V18-1 i V18-2, §5 zadatak 3). Status: **aditivno, unatrag kompatibilno** (API 1.152.1: granice teksta broje Unicode točke, neispravan id je 404 prije čitanja tijela; rute su od 1.142.0, bez novih kodova grešaka). Ovisi o SRV-V18-UPITNIK-BAZA (migracija `20261219380000_questionnaire.sql`, adapter `createQuestionnaireStore`). Upitnike izrađuje i objavljuje SRV-V18-UPITNIK-AUTOR; izvoz je SRV-V18-UPITNIK-IZVOZ.

## Načela

- **Odgovori nemaju ime.** List nema stupac s osobom ni vrijeme. Sudjelovanje (tko je ispunio) čuva se odvojeno i nema vezu na list. Nijedna ruta ne vraća ni prima osobu uz odgovore.
- **Pristup iz odnosa** (C-23): student upisan u kolegij, nastavnik kolegija. Tuđi, nepoznat, neispravan i, za studenta, neotvoren (nacrt ili zatvoren) upitnik isti su 404.
- Prijava samo AAI@EduHr (D-09). Nema rangiranja, bodova osobe ni automatskih sankcija. Ni jedna ruta ne zove pomoćnika.
- Samo izmišljeni podaci u testovima i seedu (`demo-*`); stvarni ispitanici tek po DPIA-i (OP-V18-1).

## Rute

| Operacija                                     | Ruta                                                        | Pristup            |
| --------------------------------------------- | ----------------------------------------------------------- | ------------------ |
| `student.questionnaires.get`                  | `GET /api/v1/student/questionnaires`                        | `student_enrolled` |
| `student.questionnaire.get`                   | `GET /api/v1/student/questionnaires/{id}`                   | `student_enrolled` |
| `student.questionnaire-responses.post`        | `POST /api/v1/student/questionnaires/{id}/responses`        | `student_enrolled` |
| `teacher.questionnaire-manual-responses.post` | `POST /api/v1/teacher/questionnaires/{id}/responses/manual` | `course_teacher`   |

### Popis i obrazac (student)

```
GET  /student/questionnaires      -> 200 { questionnaires: [{ id, courseId, title, participated }] }
GET  /student/questionnaires/{id} -> 200 { id, courseId, title, participated,
                                          questions: [{ id, order, kind, text, options, scale }] }
```

- Popis sadrži samo otvorene upitnike kolegija u koje je student upisan. `participated` je `true` kad je taj student već odgovorio („već ispunjeno”).
- `kind`: `single | multiple | scale | number | text`. `options` (`[{code, label}]`, 2 do 20) imaju samo `single` i `multiple`, `scale` (`{min, max}`) samo `scale`; inače `null`. Pitanja su redom koji je odredio autor.

### Ispunjavanje (student) i ručni unos (nastavnik)

```
POST { answers: [{ questionId, value }] }   // 1 do 40 odgovora, najviše jedan po pitanju
204  (bez tijela)
```

| Vrsta      | `value`                                              |
| ---------- | ---------------------------------------------------- |
| `single`   | kod opcije (string)                                  |
| `multiple` | niz različitih kodova opcija, najmanje jedan         |
| `scale`    | cijeli broj unutar `min` do `max` pitanja            |
| `number`   | konačan broj, najviše 10^9 po apsolutnoj vrijednosti |
| `text`     | tekst od 1 do 2000 znakova bez kontrolnih znakova    |

- Pitanje bez odgovora je pitanje bez odgovora (nije obavezno).
- **Student:** jednom po upitniku. Drugi put je 409 `conflict` i ništa se ne sprema. Sprema se list bez osobe i, odvojeno, činjenica sudjelovanja.
- **Nastavnik (ručni unos):** list bez osobe i bez sudjelovanja, pa ne sprječava nijednog studenta da odgovori. Samo dok je upitnik otvoren; nacrt i zatvoren su 409 `conflict`. Student, nastavnik drugog kolegija, nepoznat i neispravan id su 404.
- Tijelo koje nije točno ovo (dodatno polje, osoba uz odgovor), odgovor koji ne odgovara pitanju i pitanje koje nije iz tog upitnika su 422 `invalid_input`, prije bilo kakvog upisa.
- Ostale greške: 401 `unauthorized`, 415, 400 `invalid_json`, 413, 408, 403 (zaštita mutacije), 503 `unavailable`. Najveće tijelo 512 KiB.

## Pretpostavke

- „Zatvoren upitnik 404 po katalogu” za studenta; za ručni unos nastavnika nacrt/zatvoren je 409 jer nastavnik upitnik vidi (funkcija `app.manual_questionnaire_response`).
- 204 za oba POST-a (kao `auth.webauthn-registration.post`); klijent ponovno čita popis ako mu treba `participated`.
- Svaki odgovor na čitanje provjerava se prema ugovoru; odgovor izvan ugovora je 503.

## Primjer (izmišljen)

```
POST /api/v1/student/questionnaires/00000000-0000-4000-8000-0000000000b1/responses
{ "answers": [ { "questionId": "00000000-0000-4000-8000-0000000000f1", "value": "da" },
               { "questionId": "00000000-0000-4000-8000-0000000000f2", "value": 3 } ] }
-> 204
```

## Testovi

`server/http/questionnaire-responses.integration.test.ts` (loš ulaz, neispravan id, 401, preslikavanje grešaka baze, odgovor izvan ugovora), vektori u `server/contracts/vectors/`, `packages/test-fakes/dev-server/questionnaire-routes.ts` (lažni dev server), `tests/db/logout-old-cookie.integration.test.ts` (401 za staru sesiju), adapter `server/database/questionnaire/questionnaire.test.ts` i pgTAP `db/main/tests/247-questionnaire.sql` (SRV-V18-UPITNIK-BAZA).
