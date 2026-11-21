# HTTP za konfiguraciju ustanove

`GET /api/v1/institution/config` (trenutna verzija i povijest) i `POST /api/v1/institution/config/versions` (nova verzija) za administratora ustanove (SRV-1406, plan M2 C1–C3), nad `server/database/institution-config` (SRV-1405). Odgovor je `{ version, effectiveFrom, rules }`; `effectiveFrom` je trenutak nastanka verzije u bazi.

Pravila, tko smije i revizijski zapis su u bazi (`app.publish_institution_config`, `audit.institution_config_event`); rukovatelj dodaje samo oblik zahtjeva, preslikavanje ishoda (nastavnik i student 403, neispravna pravila 422, zastarjela `expectedVersion` 409) i `Cache-Control: no-store`. Tijelo POST-a nosi pravila uz `expectedVersion` (generator ugovora ne prevodi ugniježđeni niz).
