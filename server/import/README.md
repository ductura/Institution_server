# server/import

Uvoz datoteka u rad prema [Karti servera](../../docs/server-map.md).

## Što radi

Čita primljenu datoteku i od nje gradi pregled uvoza: dokument Ducture (shema v2), tragove i manifest `ductus-import-manifest-v1` s tri hasha (SRV-1803, plan M8.2; ugovor [import-contract](../../docs/adr/import-contract.md)). Danas samo DOCX (`docx/`). Ništa iz datoteke se ne pokreće, ne otvara ni ne dohvaća.

## Tko ga zove

`http` (rute `POST /api/v1/works/{documentId}/imports` i `.../imports/{importId}/confirm`, `server/http/import`).

## Koje podatke dira

Samo bajtove koje je ruta primila, u memoriji. Ne piše bazu ni pohranu; zapis uvoza (`collaboration.import_event`) piše `server/database/import` kroz RPC.

## Što izvozi

`readDocx` (čitanje DOCX-a u dokument v2 i tragove ili kod odbijanja iz ugovora) i `prepareDocxImport` (pregled s manifestom, hashovima i normaliziranim nazivom datoteke).

## Što ne smije uvoziti

Smije samo `domain` i `contracts` (karta §2) te paket `fflate` za raspakiravanje. Ne uvozi `database`, `http` ni vanjske priključke.
