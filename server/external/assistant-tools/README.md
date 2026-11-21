# server/external/assistant-tools

Alati AI pomoćnika, koraci 4 i 5 ugovora Ductus `docs/contracts/ai-tools-v1.md` (C-37, plan napada Ductus#1664; SRV-1207). Bez stvarnog pružatelja, mreže i tajne (OA-1, OA-2, Q-10).

- `faculty-config.ts`: čitač verzionirane postavke `config/faculties/<fakultet>.json` (odluka vlasnika OC-1). Zamjenjuje konstantu iz SRV-1206 uz isti zadani ishod: ustanova bez valjane datoteke ima obje zastavice isključene i nijedno odredište. Datoteke se čitaju jednom, pri sastavljanju; nijedan put za studenta, nastavnika ni administratora ih ne mijenja (S3-D6). Mijenjaju se samo PR-om koji odobri vlasnik; za pilot su sve zastavice `false`, a popisi odredišta prazni (OC-2).
- `search-guard.ts`: jedini put iz sloja alata prema mreži, `search(destinationId, query)`. Odredište bira poslužitelj s popisa, upit ide samo kao kodirani parametar, svaka razriješena adresa mora biti javna, preusmjerenje se ne slijedi, a tijelo ima granicu prije čitanja (S3-N1 do S3-N4). Transport se predaje izvana; produkcijska kompozicija nema ga (`NO_TRANSPORT`), a popis je prazan, pa se nijedna veza ne otvara.
- `tool-loop.ts`: petlja alata rute AI-ja. Svaki zahtjev za alatom iz polja `tool_calls` je jedan korak kroz `begin_tool_step` prije izvršavanja; granica koraka daje `tool_step_limit`, opoziv `request_revoked`, odgovor iznad granice `response_too_large`, sve bez novog poziva pružatelja. Odbijen korak ide modelu kao `tool_denied` s kodom ishoda.

Uvozi samo [`../../domain`](../../domain/README.md).
