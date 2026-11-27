# server/http/statement

## Što radi

Rute izjave spremaju nacrt ili verziju potvrđenu za trenutačnu reviziju. Vanjski se ispis učitava kao PDF ili TXT, uz sažetak primljenih bajtova. Učitavanje i odabir priloga dva su odvojena zahtjeva. Popis vlastitih razgovora s Asistentom koje je moguće priložiti (`declaration-conversations`, samo čitanje) vraća `throughSeq` i `messagesSha256` svakog; PUT izjave još ne prima razgovore u `ai.attachments` (to lomi ugovor odgovora, čeka odluku vlasnika).

## Tko ga zove

Rute pod `/api/v1/student/assignments/{assignmentId}` zove prijavljeni student zadatka.

## Koje podatke dira

Aktivan obrazac je najviša verzija u `config/faculties/<slug>/declaration/<verzija>.json`, relativno prema radnoj mapi servera. Potvrda sprema tekst i SHA-256 izvornih bajtova obrasca. Nova datoteka objavljuje se uz odobrenje vlasnika. U testovima vrijedi samo izmišljeni obrazac.

## Što izvozi

`createStatementRoutesFor` montira četiri studentske rute. Vezu predaje i izjave zapisuje baza pri upisu zahtjeva za predaju.

## Što ne smije uvoziti

Rute imaju pristup konfiguraciji obrasca, sesiji i izjavi. Bajtovi priloga ostaju u pohrani i iz njih se izvode duljina i SHA-256.
