# server/deletion/restore-drill

Proba povrata na sintetičkom obliku (plan M10.Z1; D-272 MQ07, D-273 MQ15). Čista logika bez baze i sata; pozivatelj predaje nadgrobne zapise vraćene baze i stavke kopije.

- Povrat se otvara samo ako se nadgrobni zapisi vraćene baze podudaraju s potpisanom kontrolnom točkom evidencije brisanja (`verifyErasureCheckpoint`, SRV-1302). Ako se ne podudaraju, povrat je zatvoren i ništa iz kopije ne prolazi.
- Kad je povrat otvoren, stavka kopije čija se klasa i osoba vode kao izbrisani (nadgrobni zapis) ne vraća se; vraća se u popisu `withheld`.
- Prima samo izmišljenu ustanovu (ID s prefiksom `5d5d5d5d-0000-4000-8000-`); svaka druga daje `not_synthetic`. Stvarna baza ili kopija nije dio ovog koraka (M10.Z2, M11.2-P04).
- Odgovor je zatvoren kod; nikad ne nosi ulaznu vrijednost.

Nositelj probe na stvarnoj infrastrukturi je `scripts/operations/restore-drill/` (M11.2-P04); ovaj korak daje samo provjeru koju ta skripta zove.
