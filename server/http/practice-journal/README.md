# server/http/practice-journal

Šest ruta dnevnika stručne prakse (val 19, SRV-V19-DNEVNIK-RUTE): `practice.placements.post|get`, `practice.entries.get|post`, `practice.signoffs.post|get`, ugovor u [docs/contracts/practice-journal-v1.md](../../../docs/contracts/practice-journal-v1.md). Rukovatelj provjerava oblik (ugovor), a tko smije što odlučuje baza iz odnosa (student prakse, mentor mentorstva): tuđa, nepoznata i neispravna praksa su isti 404 (C-23). Provjere ulaza koje obrazac ne može reći (datum koji postoji, redoslijed razdoblja, NFC) radi adapter iz `server/domain/practice-journal` prije poziva baze.

- ZD401 → 401, ZD404 → 404, ZD422 → 422; ZD409 je `placement_closed` ili `conflict` (zapis) odnosno `nothing_to_sign` (potpis); sve drugo je 503. Rukovatelj čita poruku samo za ZD409 zapisa, jer je to jedini SQLSTATE s dva odbijanja; poruke su fiksni tekstovi migracije `20261219100000`, nikad ulaz.
- Montira ih `server/server.ts` (`createPracticeJournalRoutesFor(databases.main)`).
- Testovi: `index.integration.test.ts` (rute nad skriptiranom bazom) i `tests/db/practice-journal.pg.integration.test.ts` (prava baza: student, mentor, tuđi, JCS sažetak jednak onom iz domene).
- Ništa ne ocjenjuje, ne rangira i ne ulazi u ocjenu ni izvoz; mentorove privatne bilješke nisu dio nijednog odgovora.
