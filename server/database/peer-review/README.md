# server/database/peer-review

Adapter anonimne recenzije (val 19, SRV-V19-RECENZIJA-RUTE): `createPeerReviewStore(withActor)`. Svaki poziv je jedna `withActor` transakcija s `app.*` RPC-ima iz migracije `20261219340000`:

- nastavnik: `set_peer_review_round`, `peer_review_round`, `allocate_peer_review`, `peer_review_overview`, `withdraw_peer_review`;
- student: `peer_review_tasks`, `peer_review_work`, `add_peer_review`, `peer_reviews_received`.

Klijent nikad ne piše izravno u tablice.

- **Dodjela:** radi je samo baza. Ovdje se ništa ne dodjeljuje.
- **Odgovori studentu:** grade se polje po polje kroz `server/domain/peer-review`, pa ništa osim ugovorenih polja ne izlazi.
- **ZD409:** zadržava poruku baze (`already_allocated`, `too_few_submissions`, `closed`, `already_reviewed`, `conflict`), a ruta je pretvara u razlog.
- **Pregled nastavnika:** poredak je domenski, po imenu recenzenta, pa autora. Osoba bez imena je pokvaren zapis (503), a ne anonimna osoba.
