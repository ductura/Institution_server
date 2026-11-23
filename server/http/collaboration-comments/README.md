# server/http/collaboration-comments

Postavlja rutu `POST /api/v1/comments/{action}`. Kolačić određuje sesiju, a postojeće funkcije baze provjeravaju odnos prema radu i ovlasti za pojedinu radnju.

Pri stvaranju komentara uz tekst koristi spremljeni prikaz rada (predanu reviziju ako postoji). Opći komentar ima `anchor: null` i ne treba tekst rada. Rukovatelj čita i upisuje samo zajedničke niti komentara, odvojene od dokumenta, zapisa procesa i privatnih bilježaka.

INT-15-SRV: `create` prima i `revision` (cijeli broj ≥ 1), reviziju rada na kojoj je nit napisana. Nastavnik je mora poslati, student smije. Baza (`collaboration.check_thread_revision`) provjerava, tek nakon odnosa prema radu, da je to revizija tog rada koju pozivatelj smije vidjeti (ne mora biti zadnja); kriva ili nedostajuća je 422. `list` vraća reviziju niti uz svaku stavku, pa je odgovor nasljeđuje; starije niti imaju `null`.
