# server/domain/peer-review

Anonimna recenzija među studentima (val 19, SRV-V19-RECENZIJA-RUTE; ugovor [docs/contracts/peer-review-v1.md](../../../docs/contracts/peer-review-v1.md)). Samo čiste funkcije bez I/O-a.

- **Anonimnost po obliku** (`anonymous.ts`): `anonymousRubrics`, `anonymousBlocks` i `anonymousReview` grade odgovore koje student čita polje po polje iz redaka baze i ne prepisuju ništa drugo. Ako redak nosi osobu, rad, zadatak, id bloka, oznaku ili vrijeme, to ne izlazi. Nepoznata vrsta bloka ruši odgovor (503) umjesto da se pokaže pod drugim imenom.
- **Dodjela nije ovdje.** Dodjelu radi samo baza (`institution.peer_review_pairs`, sjeme je id kruga), a pgTAP `249` provjerava da nema samorecenzije ni uzajamnosti i da svatko recenzira i dobiva točno k recenzija. Druga dodjela u TS-u bila bi druga istina.

Ništa ovdje ne ocjenjuje, ne rangira i ne sankcionira.
