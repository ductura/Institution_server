# server/database/portable-record

Izvor prenosivog zapisa jedne predaje (SRV-1312, plan M7.10), samo za studenta koji ju je predao.

## Što radi

U jednoj transakciji pod `withActor` zove tri postojeća čitanja, pa o svakom odlučuje sesija:

- `app.read_submission_receipt`: samo vlastita potvrda pozivatelja; tuđa, nepoznata i predaja bez potvrde daju isti `not_found` (C-23);
- `app.read_work_export`: točni spremljeni bajtovi teksta predane revizije, za vlasnika rada (zadatak za vježbu nema izvoz, pa ni zapis: `not_found`);
- `app.public_receipt_verification`: čitanje javne provjere (SRV-9B) koje navodi ključ kojim je potvrda potpisana.

Ne piše ništa i ne uvodi novu funkciju baze. Svaki redak se provjerava prije izlaska iz mape; potvrdu (JCS, digest, potpis) i otisak teksta provjerava graditelj u `server/downloads/portable-record`.

## Tko ga zove

`server/http/portable-record` s tokenom sesije iz kolačića.

## Koje podatke dira

Samo čita, kroz navedene funkcije. Nikad ne piše.

## Što izvozi

`createPortableRecordReader` i tipove iz `index.ts`.

## Što ne smije uvoziti

Vrijede rubovi iz [karte servera](../../../docs/server-map.md).
