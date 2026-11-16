# server/external/email

Područje iz [karte servera](../../../docs/server-map.md). Ima port slanja i obrazac poziva vanjske usluge (S-1E-c, DAN-837); pravi adapter (Mailpit lokalno, usluga u EU-u u produkciji) dolazi s prvim zadatkom koji šalje e-poštu.

## Što radi

Slanje e-pošte: lokalno Mailpit, u produkciji usluga u EU-u. `guardEmail(sender, caller)` stavlja port `EmailSender` pod obrazac iz `server/metrics` (`createExternalCaller`): rok, dostupnost i događaj `external_call`. Slanje nije idempotentno, pa se ne ponavlja: poruka ide najviše jednom, a istek roka znači „nije poznato je li poslano” (`EMAIL_TIMEOUT`), nikad „poslano”.

## Tko ga zove

`legal`, `deletion` i `http`. Adapter stvara `http` i predaje ga područjima kao port; ona ga uvoze samo s `import type`.

## Koje podatke dira

Ništa trajno. Adresa, predložak i vrijednosti postoje samo tijekom slanja i ne idu u događaj ni u grešku.

## Što izvozi

- `EMAIL_ROUTES`: popis ruta, za sada prazan (`routes.ts`);
- `EMAIL_SCHEMAS`: sheme, za sada prazne (`schemas.ts`);
- `EmailService`: tip servisa bez članova (`service.ts`);
- `EmailSender`, `EmailMessage`, `EmailSendAnswer`: port slanja (`sender.ts`);
- `guardEmail`, `GuardedEmail`, `EmailSendResult`: port pod obrascem poziva (`sender.ts`);
- `EMAIL_TIMEOUT`, `EMAIL_UNAVAILABLE`, `EMAIL_ERRORS`: greške `{ code, messageKey }`, tekst u `locales/hr.json` pod `email`.

Lažna e-pošta (`ok`, `slow`, `down`) je u [test-support/fake-services](../../../test-support/fake-services/README.md).

## Što ne smije uvoziti

Smije uvoziti samo `settings`, `log` i `metrics`. Ne uvozi druge adaptere iz `external/` ni feature područja. Popis je u [karti servera, §2](../../../docs/server-map.md#2-dopušteni-uvozi); provjeru u CI-ju uvodi S-1A-b.
