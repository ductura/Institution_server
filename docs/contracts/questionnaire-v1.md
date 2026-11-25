# Upitnik kolegija: izrada i objava v1

Zadatak: SRV-V18-UPITNIK-AUTOR `srv-v18-upitnik-autor` (Ductus#2058, nalog c.7173075140; val 18, `docs/nalazi/val18-razlika.md` u WEB repou, §5 zadatak 2, nalazi V18-1 i V18-2). Status: **aditivno, unatrag kompatibilno** (API 1.142.0). Baza je `SRV-V18-UPITNIK-BAZA` (`20261219380000_questionnaire.sql`, spojeno); ovdje su samo rute nastavnika. Ispunjavanje (`SRV-V18-UPITNIK-ISPUNJAVANJE`) i izvoz (`SRV-V18-UPITNIK-IZVOZ`) dolaze zasebno.

## Načela

- Autor je **nastavnik kolegija** (`course_teacher`), ne student (V18-2): student anketiranje drugih studenata ne smije raditi bez etičkog odobrenja i DPIA. Pristup nastaje iz odnosa (nastavnik kolegija, C-23); ustanova i autor dolaze iz sjednice, nikad iz tijela.
- **Odgovori nemaju ime** (V18-1). Ove rute ne čitaju nijedan listić; `responseCount` je samo broj, a sudjelovanje se nikad ne vraća nastavniku.
- **Stanje ide u jednom smjeru**: `draft` → `open` → `closed`. Nacrt se smije mijenjati; otvoren i zatvoren upitnik ne. **Brisanja nema**: zatvoren upitnik ostaje.
- Tuđe, nepoznato i neispravno je isti **404**: nastavnik drugog kolegija, druga ustanova, student, nepoznat i neispravan id.
- Korak koji stanje ne dopušta (izmjena otvorenog, dvostruko otvaranje, zatvaranje nacrta) je **409 `conflict`**; ništa se ne mijenja.
- Pitanja imaju zatvoren skup vrsta `single | multiple | scale | number | text`. Ocjene, ranga ni zbroja po osobi nema. Samo izmišljeni podaci.

## Rute

Svaka ima 401 `unauthorized`, 404 `not_found`, 503 `unavailable`; mutacije još `MUTATION_GUARD`, 415, 400 `invalid_json` i 422 `invalid_input`; odgovori nose `cache-control: no-store`.

| ID rute                            | Metoda i put                                            | Pristup          | Odgovor                            |
| ---------------------------------- | ------------------------------------------------------- | ---------------- | ---------------------------------- |
| `teacher.questionnaires.get`       | `GET /api/v1/teacher/courses/{courseId}/questionnaires` | `course_teacher` | 200 `{questionnaires[]}`           |
| `teacher.questionnaires.post`      | `POST` isti put                                         | `course_teacher` | 201 upitnik (nacrt)                |
| `teacher.questionnaire.get`        | `GET /api/v1/teacher/questionnaires/{id}`               | `course_teacher` | 200 upitnik                        |
| `teacher.questionnaire.patch`      | `PATCH` isti put (samo `draft`, inače 409)              | `course_teacher` | 200 upitnik                        |
| `teacher.questionnaire-state.post` | `POST /api/v1/teacher/questionnaires/{id}/state`        | `course_teacher` | 200 `{id, state}`; krivi korak 409 |

### Tijelo POST-a i PATCH-a

Točno `{title, questions}`, najviše 256 KiB (veće je 413). `title` je jedan redak od 1 do 200 znakova. `questions` ima 1 do 40 pitanja, svako točno `{kind, text, options?, scale?}`; poredak je poredak niza.

- `text`: jedan redak od 1 do 500 znakova, bez razmaka na rubovima i bez kontrolnih znakova.
- `options` samo za `single` i `multiple`: 2 do 20 objekata `{code, label}`; `code` je kratka riječ (`a-z`, `0-9`, `-`, do 40 znakova), jedinstvena u pitanju; `label` je jedan redak do 120 znakova.
- `scale` samo za `scale`: `{min, max}`, cijeli brojevi 0 do 10, `min` < `max`.
- `number` i `text` nemaju ni `options` ni `scale`.

Ugovor `options` i `scale` u zahtjevu piše otvoreno (`unknown`), jer generator ugovora ne čita objekt ugniježđen u element niza; točan oblik provjeravaju domena (`isQuestionList`) i baza, a sve izvan pravila je 422 `invalid_input` prije ikakvog upisa. Odgovor oblik piše do kraja.

### Odgovor

```json
{
  "id": "00000000-0000-4000-8000-0000000b1801",
  "courseId": "00000000-0000-4000-8000-0000000a1801",
  "title": "Izmišljeno istraživanje: navike kompostiranja",
  "state": "draft",
  "questions": [
    {
      "id": "00000000-0000-4000-8000-0000000c1801",
      "order": 1,
      "kind": "single",
      "text": "Kompostirate li kod kuće?",
      "options": [
        { "code": "da", "label": "Da" },
        { "code": "ne", "label": "Ne" }
      ],
      "scale": null
    }
  ]
}
```

`options` je `null` ako vrsta nije `single` ni `multiple`, a `scale` je `null` ako vrsta nije `scale`. Popis (`GET` kolegija) vraća `{id, title, state, createdOn, questionCount, responseCount}`, najnoviji prvi.

## Pretpostavke

- Putanja `server/http/questionnaires.ts` iz naloga postaje `server/http/questionnaires/index.ts` (svaka mapa ima `index.ts`, `docs/CODE_STYLE.md` §10).
- POST odgovara 201 s cijelim upitnikom (ID-evi pitanja trebaju WEB-u za ručni unos i ispunjavanje).
- Najveće tijelo 256 KiB (40 pitanja, 20 opcija) i oblik popisa su odluka ovog zadatka; mijenjaju se aditivno.
- Svi nazivi su izmišljeni; seed „Izmišljeno istraživanje: navike kompostiranja” dolazi s BAZOM.

## Otvoreno

- OP-V18-2 (naziv ustanovnog tijela za odobrenje istraživanja, polje „odobrenje”): po zapisanoj pretpostavci polja nema u ovom valu.
