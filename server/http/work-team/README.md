# server/http/work-team

Devet ruta timova na zadatku (val 19, SRV-V19-GRUPA-RUTE; ugovor [docs/contracts/work-team-v1.md](../../../docs/contracts/work-team-v1.md)): `createWorkTeamRoutesFor(databases.main)`. Rukovatelj provjerava oblik (neispravan id u putanji je 404, neispravno tijelo 415, 400 ili 422), a baza odlučuje tko smije što; tuđe, nepoznato i neispravno je isti 404 (C-23). Doprinos je isto tijelo za studenta i nastavnika i nijedna druga ruta ga ne nosi.
