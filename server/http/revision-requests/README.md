# revision-requests

HTTP rub zahtjeva za doradu: `POST /api/v1/revision-requests/{action}` (SRV-2006, DAN-314 2f; radnje `create`, `respond`, `accept`, `reopen`, `rereview`, `withdraw`, `list`). Tanki rub nad funkcijama `collaboration.*_revision_request`: kolačić određuje sesiju, tijelo mora biti točno kanonski JSON s točno ključevima radnje, neispravan id čita se kao tuđi (403), a tko smije i koji je prijelaz dopušten odlučuje baza. Zastarjeli brojač je odgovor 409 `{outcome: "conflict", …}`, prijelaz koji stanje ne dopušta je 409 `not_allowed`.

Port Ductus granice `server/collaboration/revision-requests.ts`; ta kopirana datoteka ostaje izvan karte područja (`server/collaboration` nije područje, pa je `server/http` ne smije uvoziti).
