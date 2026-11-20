# Zapisi konzultacija

Port zajedničkog zapisa konzultacije o jednom radu i njegovih dopuna (SRV-1105, Ductus#2051; N-12, D-47, PO-22).

## Što radi

`createConsultationRecords(withActor)` daje `list`, `create` i `addAddition`, svaki u jednoj transakciji nad funkcijom `collaboration.list_consultation_records`, `create_consultation_record` ili `add_consultation_addition`:

- pristup odlučuje baza odnosom komentara: nastavnik zadatka ili student vlasnik rada; tuđi, nepoznati i neispravan rad su isti ZD403, koji port vraća kao `not_found` (C-23);
- revizija zapisa mora biti revizija istog rada (inače ZD422, `invalid_input`); prazna tema i prazna ili prazna-po-znakovima dopuna također;
- zapis i dopuna se samo dodaju, nikad mijenjaju ni brišu; vrijeme dopune je cijela UTC minuta (D-24);
- ishodi su vrijednosti (`ok`, `unauthenticated`, `not_found`, `invalid_input`, `unavailable`); sve drugo se baca.

Testovi: `consultation-records.test.ts`.

## Koje podatke dira

Samo tri funkcije glavne baze; korisnik i ustanova dolaze iz sesije.

## Što izvozi

`createConsultationRecords`, `isCalendarDate`, `recordsOf` i tipove odgovora.

## Što ne smije uvoziti

Ništa osim tipa `WithActor` iz `server/database`.
