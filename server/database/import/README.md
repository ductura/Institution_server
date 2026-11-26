# import

Priključak baze za uvoz datoteke u rad (SRV-1803, M8.2 i M8.2b; migracija `20261202100000_import_event.sql`, ugovor [import-contract](../../../docs/adr/import-contract.md)). Jedan poziv je jedna `withActor` transakcija nad jednim RPC-om sheme `collaboration`: `import_gate` (smije li student vlasnik sada uvoziti), `prepare_import` (poslužitelj sprema manifest koji je sam izgradio) i `confirm_import` (idempotentna potvrda pregleda). Tko smije odlučuje baza; odgovor je zatvoren status, nikad poruka baze. Ne čita i ne piše evidenciju.

`list` (SRV-F4-PM2-R14-SRV, 20261220320000): `collaboration.list_imports(document_id)` vraća metapodatke uvoza rada, najnoviji prvi, za studenta vlasnika i nastavnika zadatka; ostali dobivaju ZD403 (404). Stanje se izvodi kao u `confirm_import`. Red neočekivanog oblika je `unavailable`.
