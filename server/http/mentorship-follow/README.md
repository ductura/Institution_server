# mentorship-follow

SRV-MENTOR-3 (MK-8, MK-9, MK-11, PG-9): `GET`, `PUT` i `DELETE /api/v1/works/{documentId}/self-note`, `PUT` i `DELETE /api/v1/works/{documentId}/reading-place`, `POST /api/v1/works/{documentId}/seen`, `GET /api/v1/works/{documentId}/seen-by-student` i `GET /api/v1/teacher/mentorship-overview`. Tanki HTTP rub nad `server/database/mentorship-follow`: sesija, oblik zahtjeva i zatvoreni odgovori; tko smije odlučuje baza.

Od SRV-NF6-SIFRA (migracija `20261217150000_self_note_sealed.sql`, API 1.110.0) bilješka sebi je šifrirana i ide kroz `self-note-sealed`; ovdje se više ne čuva tekst (`note` je uvijek `null`, upis teksta ne sprema ništa), a položaj čitanja radi kao prije.
