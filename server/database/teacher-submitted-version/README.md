# server/database/teacher-submitted-version

## Što radi

Adapter za nastavnikovo čitanje predane revizije rada studenta (F4-NAS-R20-SRV). Jedna transakcija kroz postojeće RPC-e: `app.teacher_work_get` odlučuje smije li pozivatelj čitati rad, `app.assignment_submissions` daje reviziju žive predaje, `collaboration.read_live_state` daje predani tekst i upisuje redak u dnevnik pristupa (`submitted_text`).

## Tko ga zove

`server/http/teacher-submitted-version`.

## Koje podatke dira

Samo čita; dnevnik pristupa piše postojeći RPC. Nema migracije.

## Što izvozi

`createTeacherSubmittedVersion` i tipove ishoda. Tuđi rad, nepredan rad, druga revizija i bez odnosa su isti `not_found` (C-23).

## Što ne smije uvoziti

Upotrebljava javna sučelja područja iz [Karte servera](../../../docs/server-map.md).
