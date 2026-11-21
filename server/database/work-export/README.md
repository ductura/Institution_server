# server/database/work-export

Izvor izvoza DOCX-a jednog rada (SRV-1310, plan M8.4): jedna spremljena verzija s točnim bajtovima teksta, za vlasnika rada i nastavnika zadatka.

## Što radi

Zove `app.read_work_export` pod `withActor`. Pristup odlučuje baza istim odnosom kao `app.read_work_versions` (`collaboration.document_scope` i `actor_role`): tuđi, nepoznat i neispravan rad te nepoznata verzija daju isti odgovor `not_found` (C-23). Verzije se režu na predanoj reviziji. Čitanje nastavnika upisuje redak dnevnika pristupa u istoj transakciji. Redak se provjerava prije izlaska iz mape.

## Tko ga zove

`server/http/work-export` s tokenom sesije iz kolačića.

## Koje podatke dira

Samo čita: `evidence.document_checkpoint` kroz pomoćnu funkciju uloge evidence, izvršivu samo za ulogu identiteta. Nikad ne piše.

## Što izvozi

`createWorkExportReader`, `sourceOf` i tipove iz `index.ts`.

## Što ne smije uvoziti

Vrijede rubovi iz [karte servera](../../../docs/server-map.md).
