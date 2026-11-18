# server/downloads

Područje iz [karte servera](../../docs/server-map.md). Od DAN-932 (S-1H.5-b) ima servis manifesta desktop paketa; ruta je u `server/http/downloads-manifest.ts`.

## Što radi

Preuzimanja: izvozi i instalacijski paketi aplikacija. Feature područje: logika rute je u `service`.

Manifest (`GET /api/v1/downloads/manifest`, ugovor DAN-931): servis čita konfiguraciju izdanja i vraća je cijelu ili nikako, nikad djelomičan popis. Redom: kopija čistih podataka (`structuredClone`: samo vlastita nabrojiva polja, getter se čita jednom, funkcija i Proxy bacaju), shema odgovora 200 iz ugovora, pa parovi sustava i arhitekture strogo rastući (poredak i jedinstvenost, koje shema ne izražava). Poredak je po kodnim točkama (`macos` prije `windows`, `arm64` prije `x64`). Odbijanje je jedan od tri zatvorena koda (`DOWNLOADS_RELEASES_UNREADABLE`, `_INVALID`, `_ORDER`; `messageKey` je `errors.unavailable`), a ruta odgovara 503 `unavailable`. Kod ne nosi nijednu vrijednost konfiguracije.

Konfiguracija izdanja je `releases.ts` (`DESKTOP_RELEASES`, zamrznuta i bez izvoza iz `index.ts`), ugrađena u build kao `settings/institutions-file.ts`; servis je čita kad mu se ne preda drugi čitač. Desktop izdanja još ne postoje, pa je popis prazan. Simulacija preuzimanja za četiri kombinacije (S-1H.6) je `server/http/downloads-simulation.integration.test.ts`, nad lažnim datotekama.

## Tko ga zove

Samo `http`.

## Koje podatke dira

Za sada samo konfiguraciju izdanja ugrađenu u build (`releases.ts`); bazu i pohranu ne dira. Objekti u pohrani i zapis preuzimanja u glavnoj bazi dolaze s mjestom paketa.

## Što izvozi

- `DOWNLOADS_ROUTES`: popis ruta, prazan; ruta manifesta je u `http` (`routes.ts`);
- `DOWNLOADS_SCHEMAS`: sheme, prazne; shema je u ugovoru (`schemas.ts`);
- `createDownloadsService`, `DownloadsService`, `DownloadsManifest`, `DownloadsPackage` (`service.ts`);
- `DOWNLOADS_ERRORS` i tri koda odbijanja `DOWNLOADS_RELEASES_UNREADABLE`, `DOWNLOADS_RELEASES_INVALID`, `DOWNLOADS_RELEASES_ORDER` (`service.ts`).

## Što ne smije uvoziti

Smije uvoziti samo `settings`, `log`, `metrics`, `domain`, `contracts`, `database` i `external/storage`, i to kroz njihov `index.ts`. `database` i `external/storage` uvozi samo s `import type` (tip porta); adapter mu predaje `http`. Ne uvozi `http` ni `test-server`. S drugim feature područjima dijeli podatke samo kroz bazu i RPC. Popis je u [karti servera, §2](../../docs/server-map.md#2-dopušteni-uvozi); provjeru u CI-ju uvodi S-1A-b.
