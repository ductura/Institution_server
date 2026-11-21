# import

`POST /api/v1/works/{documentId}/imports` i `POST /api/v1/works/{documentId}/imports/{importId}/confirm` (`work.imports.post`, `work.imports.confirm.post`, SRV-1803). Tanki HTTP rub: sesija, oblik zahtjeva i zatvoreni odgovori. Prvo pita bazu smije li student vlasnik uvoziti u rad (`import_gate`), tek onda `server/import` čita datoteku i gradi manifest, a `server/database/import` ga sprema. Pregled je označen izvorom `import` i vrstom dokaza `imported`; u rad ulazi tek potvrdom, koja je idempotentna. Tko smije odlučuje baza.
