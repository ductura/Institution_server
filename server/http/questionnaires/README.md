# Upitnici kolegija, HTTP rub (SRV-V18-UPITNIK-AUTOR)

`createQuestionnaireRoutesFor(main)` montira pet ruta iz `server/contracts/routes/questionnaires.ts`: `teacher.questionnaires.get` i `.post` (`/api/v1/teacher/courses/{courseId}/questionnaires`), `teacher.questionnaire.get` i `.patch` (`/api/v1/teacher/questionnaires/{id}`) i `teacher.questionnaire-state.post` (`…/{id}/state`). Ugovor je opisan u `docs/contracts/questionnaire-v1.md`.

- Tko smije odlučuje baza iz odnosa (nastavnik kolegija); ustanova i autor dolaze iz sjednice. Student, nastavnik drugog kolegija, druga ustanova, nepoznat i neispravan id dobivaju isti 404.
- POST i PATCH primaju točno `{title, questions}` (najviše 256 KiB); oblik izvan ugovora, naslov ili pitanja koje domena ili baza odbije su 422 `invalid_input`. POST odgovara 201 s upitnikom i ID-evima pitanja.
- PATCH mijenja samo nacrt; otvoren ili zatvoren upitnik je 409 `conflict`. Stanje ide jednosmjerno `draft` → `open` → `closed`; svaki drugi korak je 409.
- Brisanja nema. Listići odgovora se ovdje ne čitaju i ne nose osobu; `responseCount` je samo broj.
- Port baze: `server/database/questionnaire`.
