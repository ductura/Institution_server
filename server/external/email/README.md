# server/external/email

Područje iz [karte servera](../../../docs/server-map.md). Mapa je za sada prazna (S-1A-a): ima samo prazne izvoze i tipove, bez logike.

## Što radi

Slanje e-pošte: lokalno Mailpit, u produkciji usluga u EU-u.

## Tko ga zove

`legal`, `deletion` i `http`. Adapter stvara `http` i predaje ga područjima kao port; ona ga uvoze samo s `import type`.

## Koje podatke dira

Ništa trajno. Adresa i predložak postoje samo tijekom slanja.

## Što izvozi

- `EMAIL_ROUTES`: popis ruta, za sada prazan (`routes.ts`);
- `EMAIL_SCHEMAS`: sheme, za sada prazne (`schemas.ts`);
- `EmailService`: tip servisa bez članova (`service.ts`).

## Što ne smije uvoziti

Smije uvoziti samo `settings`, `log` i `metrics`. Ne uvozi druge adaptere iz `external/` ni feature područja. Popis je u [karti servera, §2](../../../docs/server-map.md#2-dopušteni-uvozi); provjeru u CI-ju uvodi S-1A-b.
