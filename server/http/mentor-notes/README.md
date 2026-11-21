# Privatne bilješke mentora

`GET /api/v1/mentorships/{id}/notes` vraća bilješke prijavljenog mentora od najstarije. `POST` dodaje običan tekst. Za nedostupno mentorstvo odgovor je 404. Odgovori s bilješkama koriste `Cache-Control: no-store`.
