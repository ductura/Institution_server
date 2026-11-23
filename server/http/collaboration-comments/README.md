# server/http/collaboration-comments

Postavlja rutu `POST /api/v1/comments/{action}`. Kolačić određuje sesiju, a postojeće funkcije baze provjeravaju odnos prema radu i ovlasti za pojedinu radnju.

Pri stvaranju komentara uz tekst koristi spremljeni prikaz rada (predanu reviziju ako postoji). Opći komentar ima `anchor: null` i ne treba tekst rada. Rukovatelj čita i upisuje samo zajedničke niti komentara, odvojene od dokumenta, zapisa procesa i privatnih bilježaka.

Nit komentara veže se uz reviziju rada (INT-15-SRV): `create` prima `revision` (cijeli broj od 1). Nastavnik je mora navesti, student vlasnik rada smije. Funkcija `collaboration.create_revision_comment` provjerava odnos prema radu prije revizije, pa netko izvan rada dobiva isti odgovor kao za nepostojeći rad. Revizija mora postojati, a nastavnik smije komentirati svaku reviziju do najnovije predane (prije predaje do trenutačne), ne samo zadnju. Inače je odgovor 422. Odgovor na komentar pripada niti, pa ima njezinu reviziju. `list` uz svaku stavku vraća `revision` (null za starije niti). Sidro komentara i dalje se provjerava prema tekstu koji nastavnik trenutačno vidi.
