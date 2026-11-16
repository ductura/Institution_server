# server/evidence

Područje iz [karte servera](../../docs/server-map.md). Mapa za sada ima samo oblik servisa, bez logike (DAN-815 b1); pripremu commita donosi DAN-815 b2.

## Što radi

Dokazi rada: priprema i provjera commita segmenta (JCS, SHA-256, snimka), pohrana objekta i potpisana transakcija kroz `database`. Feature područje: logika rute je u `service`.

## Tko ga zove

Samo `http`.

## Koje podatke dira

Objekte segmenata u pohrani; revizije, segmente i potvrde u glavnoj bazi, samo kroz RPC.

## Što izvozi

- `EvidenceService`: tip servisa bez članova (`service.ts`).

## Što ne smije uvoziti

Smije uvoziti samo `settings`, `log`, `metrics`, `domain`, `database` i `external/storage`, i to kroz njihov `index.ts`. `database` i `external/storage` uvozi samo s `import type` (tip porta); adapter mu predaje `http`. Ne uvozi `http`, `contracts` ni `test-server`. S drugim feature područjima dijeli podatke samo kroz bazu i RPC. Popis je u [karti servera, §2](../../docs/server-map.md#2-dopušteni-uvozi); provjera je lint `local/area-boundary`.
