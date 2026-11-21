# legal-hold

HTTP sloj nad pravnim zadržavanjem (SRV-1306, nad SRV-1305): `GET` i `POST /api/v1/institution/legal-holds` i `POST /api/v1/institution/legal-holds/{holdId}/release`. Pravila (samo administrator ustanove, isti administrator ne skida vlastito zadržavanje) odlučuje baza; ovdje su samo okvir zahtjeva i prijevod odgovora u problem+json.
