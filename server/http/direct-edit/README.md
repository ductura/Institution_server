# direct-edit

`GET` i `PUT /api/v1/works/{documentId}/direct-edit` (`work.direct-edit.get`, `work.direct-edit.put`, SRV-1702). Tanki HTTP rub nad `server/database/direct-edit`: sesija, oblik zahtjeva i zatvoreni odgovori; tko smije odlučuje baza. Samu izmjenu nastavnik šalje kroz `live.document.put` (`server/http/live.ts`) s `If-Match` ETag-a stanja koje je pročitao, i to samo dok je postavka uključena.
