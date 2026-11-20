# work-messages

Priključak baze za kratke poruke uz rad (SRV-1106, migracija `20261121130000_work_message.sql`). Jedan poziv je jedna `withActor` transakcija nad jednim RPC-om sheme `collaboration`; tko smije (student rada i nastavnici zadatka) odlučuje baza, a razgovor je isti za sve sudionike, redom pisanja. Ne čita i ne piše dokument.
