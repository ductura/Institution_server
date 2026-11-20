# server/http/collaboration-comments

Postavlja rutu `POST /api/v1/comments/{action}`. Kolačić određuje sesiju, a postojeće funkcije baze provjeravaju odnos prema radu i ovlasti za pojedinu radnju.

Pri stvaranju komentara uz tekst koristi spremljeni prikaz rada (predanu reviziju ako postoji). Opći komentar ima `anchor: null` i ne treba tekst rada. Rukovatelj čita i upisuje samo zajedničke niti komentara, odvojene od dokumenta, zapisa procesa i privatnih bilježaka.
