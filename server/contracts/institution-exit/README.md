# server/contracts/institution-exit

Ugovor izlaza iz usluge (SRV-1810, plan M10.6-P01, D-274 MQ12, F-04): paket sa svim podacima fakulteta i njegov manifest. Odluke su u [ADR-u](../../../docs/adr/institution-exit.md). Ovdje se ne grade tablica, RPC, ruta ni posao; P02 i P03 idu nakon pilota.

- `package.ts`: TypeBox sheme i tipovi: zahtjev ustanove (`InstitutionExitRequestV1`), manifest `ductura-institution-exit-v1` (`InstitutionExitManifestV1`), zapis predaje (`InstitutionExitHandoverV1`), stanja, popis onoga što izlaz nikad ne radi.
- `check.ts`: `checkInstitutionExitManifestV1`, čitanje manifesta: zatvoren oblik, datoteke poredane i bez duplikata, svih 30 klasa podataka prisutno. Odbijanje nosi samo kod.

Pokreće ga samo operater. Izlaz ne briše ništa (`deletesNothing: true`, `deletion: "none"`). Nema rute za korisnike. Uvozi samo `@sinclair/typebox`.
