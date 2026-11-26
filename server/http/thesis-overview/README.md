# Popis završnih i diplomskih radova fakulteta (HTTP)

`createThesisOverviewRoutesFor` (SRV-V16-POPIS-FAKULTET) poslužuje rutu `GET /api/v1/institution/thesis-overview` iz `server/contracts/routes/thesis-overview.ts`. Pristup odlučuje baza (samo administrator fakulteta); adapter provjerava upit (`stage`, `limit`, `after`, svaki najviše jednom, nijedan drugi) i greške `ZD401`–`ZD422` pretvara u zatvorene riječi ugovora. Odgovor koristi `Cache-Control: no-store`.
