# Zahtjevi za mentorstvo

Četiri RPC-a glavne baze: student traži mentorstvo ili povlači svoj zahtjev, a nastavnik kojem je zahtjev upućen odobrava ga ili odbija. Mentorstvo nastaje tek odobrenjem (D-204), a ponovljeno odobrenje vraća isto mentorstvo. Identitet dolazi iz sesije vezane uz transakciju.

Dva čitanja studentske strane (SRV-1414): `app.student_mentorship_requests()` i `app.student_mentor_candidates()`. Obje funkcije odbijaju pozivatelja s potvrđenom ulogom nastavnika (ZD403); razlog odbijanja ne vraćaju (P-6), a kandidati nemaju adresu ni drugi osobni podatak osim imena. Razlog odbijanja studentu zahtjeva od F4 vala 2 #3 daje zasebna `app.student_mentorship_decline_reason(uuid)`: odgovara samo studentu tog zahtjeva (drugima ZD403, bez sesije ZD401), a čitač je zove samo za odbijene zahtjeve.
