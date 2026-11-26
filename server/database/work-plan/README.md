# work-plan

Priključak baze za plan rada iza panela „Struktura” (S-14): pitanje rada, svrha svakog poglavlja i pojmovnik. F4-PM2-R15-SRV (Ductus#2059), plan M5.14b, odluke D-234 i D-250, migracija `20261220210000_work_plan.sql`. Jedan poziv je jedna `withActor` transakcija nad jednim RPC-om sheme `collaboration` (`get_work_plan`, `put_work_plan`); tko smije odlučuje baza: samo student koji je vlasnik rada, mentor i nastavnici ne vide plan (D-234 točka 2).

Plan nije promjena dokumenta (D-234 točka 1): ne piše dokument, reviziju, segment, potvrdu ni sažetak, nije u evidenciji, prikazu uživo (D-142) ni reprodukciji (D-143). Piše se cijeli (zamjena), prazan plan briše redak. Poglavlje je id bloka naslova, nikad tekst rada. Ode s radom: sweep `collaboration.purge_orphan_work_data` briše plan rada kojeg više nema.

Odgovor je zatvoren status (`unauthenticated`, `not_found`, `invalid`, `unavailable`), nikad poruka baze; redak neočekivanog oblika je `unavailable`.
