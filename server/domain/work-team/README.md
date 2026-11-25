# server/domain/work-team

Timovi studenata na zadatku (val 19, SRV-V19-GRUPA-RUTE; ugovor [docs/contracts/work-team-v1.md](../../../docs/contracts/work-team-v1.md)). Samo čiste funkcije bez I/O-a.

- **Redoslijed** (`members.ts`): `orderByName` i `compareByName` su jedini redoslijed ljudi u timu: prezime, ime (hrvatska kolacija), pa id. Nema parametra za poredak po iznosu.
- **Doprinos** (`contribution.ts`): `assembleContribution` sastavlja odgovor iz zapisa članova (`disabled`, `none`, `pending`, `failed`, `ready`). Ne računa ništa novo, ne uspoređuje članove, nema udjela, ranga, prosjeka ni praga; napomena `not_authorship_evidence` je uvijek u `ready`.

Ništa ovdje ne ocjenjuje, ne rangira i ne sankcionira.
