# Obavijesti u aplikaciji

`GET /api/v1/notifications` vraća stranicu do 50 vlastitih obavijesti. Sljedeća se čita s `?before=<nextBefore>`. `POST /api/v1/notifications/{id}/read` prima prazan zahtjev i vraća 204. Ponavljanje čuva vrijeme prvog označavanja.

Prva stranica može dodati podsjetnik na najbliži otvoreni rok u iduća 24 sata. Studentu vrijedi njegov produljeni rok, a nastavniku rok za sve. Nakon zahtjeva za predaju studentu se za taj zadatak više ne dodaje podsjetnik. `DUCTURA_NOTIFICATION_REMINDER_INTERVAL_SECONDS` određuje razmak između podsjetnika po korisniku. Zadana vrijednost i donja granica su 300 sekundi (P-03).

Rute koriste kolačić sesije i pokreću pripadajući RPC kroz `withActor`. Odredište se otvara kroz njegovu redovitu rutu, koja provjerava pristup.
