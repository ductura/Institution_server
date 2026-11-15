# server/settings

Područje iz [karte servera](../../docs/server-map.md). Mapa je za sada prazna (S-1A-a): ima samo prazne izvoze i tipove, bez logike.

## Što radi

Postavke iz okoline i njihova provjera pri pokretanju. Odbija lažni OIDC i razvojni potpisnik izvan lokalnog rada i CI-ja (D-09).

## Tko ga zove

`log`, `metrics`, `database`, `external/srce-auth`, `external/storage`, `external/keys`, `external/email`, `traffic`, `session`, `roles`, `legal`, `backup`, `deletion`, `downloads`, `http` i `test-server`.

## Koje podatke dira

Varijable okoline. Tajne nikad nisu u repou.

## Što izvozi

- `SETTINGS_ROUTES`: popis ruta, za sada prazan (`routes.ts`);
- `SETTINGS_SCHEMAS`: sheme, za sada prazne (`schemas.ts`);
- `SettingsService`: tip servisa bez članova (`service.ts`).

## Što ne smije uvoziti

Ne uvozi ništa iz drugih područja. Popis je u [karti servera, §2](../../docs/server-map.md#2-dopušteni-uvozi); provjeru u CI-ju uvodi S-1A-b.
