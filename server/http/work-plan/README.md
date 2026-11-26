# work-plan

HTTP rub plana rada iza panela „Struktura” (F4-PM2-R15-SRV, Ductus#2059; plan M5.14b, D-234): `work.plan.get` i `work.plan.put` na `/api/v1/works/{documentId}/plan`. Samo rub: živa sjednica (401), id rada dekodiran jednom (što nije id rada je isti 404 kao tuđi rad), za upis vrsta medija, ograničeno tijelo i oblik, zatim `server/database/work-plan`. Tko smije odlučuje baza (student vlasnik rada; mentor i nastavnici dobivaju 404, D-234 točka 2). Ugovor je u `docs/contracts/work-plan-v1.md`.
