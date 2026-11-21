# assistant-tools

Priključak baze za alate AI pomoćnika (SRV-1207, korak 3 ugovora Ductus `docs/contracts/ai-tools-v1.md`, migracija `20261130100000_assistant_tools.sql`). Jedan poziv je jedna `withActor` transakcija nad jednim RPC-om sheme `assistant`: postavka alata zadatka koju mijenja nastavnik kolegija (`set_assignment_tools`, s `expected_version` i retkom revizijskog traga) i čita nastavnik ili student kolegija (`read_assignment_tools`), te koraci petlje alata rute AI-ja (`begin_tool_step`, `finish_tool_step`).

Ruta predaje samo ono što poslužitelj dopušta (zatvoren skup ∩ prekidač ∩ spremni alati iz `config/faculties`), a baza to sužava postavkom zadatka koja vrijedi u trenutku poziva i politikom. Redoslijed ishoda koraka (`denied_revoked`, `denied_not_in_set`, `denied_schema`, `allowed`) odlučuje baza. Odgovor je zatvoren status, nikad poruka baze; ime alata izvan zatvorenog skupa nikad ne dolazi u bazu kao tekst, nego samo njegov SHA-256.
