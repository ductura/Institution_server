# self-note-sealed

Priključak baze za šifriranu „Poruku sebi” (SRV-NF6-SIFRA, varijanta B2, `docs/contracts/self-note-sealed-v1.md`), migracija `20261217150000_self_note_sealed.sql`. Jedan poziv je jedna `withActor` transakcija nad jednim RPC-om sheme `collaboration`; tko smije odlučuje baza (šifriranu poruku samo student vlasnik rada, omotani ključ samo njegov vlasnik). Bajtovi ulaze i izlaze nepromijenjeni: poslužitelj ih ne može pročitati jer nikad nema ni ključ ni frazu ni kod za oporavak. Base64url mora biti kanonski i točne duljine, inače je odgovor `invalid` i ništa se ne piše.
