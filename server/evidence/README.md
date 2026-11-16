# server/evidence

Područje iz [karte servera](../../docs/server-map.md). Pripremu commita (DAN-815 b2) prenosi iz Ductusa `src/server/evidence/evidence-commit-request.ts` na `d52a92c3`.

## Što radi

Dokazi rada: priprema i provjera commita segmenta (JCS, SHA-256, snimka), pohrana objekta i potpisana transakcija kroz `database`, te stranica replaya iz provjerenih spremljenih segmenata. Feature područje: logika rute je u `service`.

## Tko ga zove

Samo `http`.

## Koje podatke dira

Objekte segmenata u pohrani; revizije, segmente i potvrde u glavnoj bazi, samo kroz RPC.

## Što izvozi

- `createEvidenceService({ committer, payloads })` i tipovi `EvidenceService`, `EvidenceCommitRequest`, `EvidenceCommitRequestOutcome`, `EvidenceCommitDependencies` (`service.ts`): priprema i commit jednog segmenta; nikad ne baca, kvar je zatvoreni kod;
- `readReplayPage({ source, payloads }, documentId, from, pin)`, `REPLAY_FORMAT`, `MAX_REPLAY_PAGE_SEGMENTS` i tipovi `ReplayPage`, `ReplayReadResult`, `ReplayReaderDeps` (`replay.ts`, DAN-818, prijenos Ductus `replay-reader.ts` na `333e163`): jedna stranica replaya s provjerenim spremljenim bajtovima segmenata. Server ne izvodi korake (B-12 na serveru je DAN-819); svaki kvar je cijeli, nikad djelomična stranica;
- `MAX_COMMIT_REQUEST_BYTES`, `DUCTUS_PROTOCOL_VERSION`, `DUCTUS_ASYNC_COMMIT_PROTOCOL`: granice rute iz `domain`, da ih `http` čita odavde (ista granica na klijentu i serveru).

## Što ne smije uvoziti

Smije uvoziti samo `settings`, `log`, `metrics`, `domain`, `database` i `external/storage`, i to kroz njihov `index.ts`. `database` i `external/storage` uvozi samo s `import type` (tip porta); adapter mu predaje `http`. Ne uvozi `http`, `contracts` ni `test-server`. S drugim feature područjima dijeli podatke samo kroz bazu i RPC. Popis je u [karti servera, §2](../../docs/server-map.md#2-dopušteni-uvozi); provjera je lint `local/area-boundary`.
