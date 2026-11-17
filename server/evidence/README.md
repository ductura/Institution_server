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
- `createSignPendingReceipt({ signer, store, checkObject, signTimeoutMs })` i tipovi `SignPendingReceiptDeps`, `SignPendingReceiptOutcome`, `PendingReceiptObjectCheck`, `PendingReceiptHold` (`sign-pending-receipt.ts`, DAN-820 820c, prijenos Ductus `sign-pending-receipt.ts` na `333e163`): potpis jedne pending potvrde v2. Redom: tekst (`pending-receipt-text.ts`), sažetak, ključevi domene, provjera objekta segmenta, potpisnik s rokom (`sign-within.ts`), provjera potpisa provjeriteljem protokola 1 s ključem iz registra domene i upis kroz spremište čiji se odgovor provjerava (`settle-attach.ts`). Ishodi su zatvoreni kodovi `status`/`reason` za worker, ne greške sučelja. Proces workera i provjera objekta (DAN-301) predaju se kao portovi; worker još ne postoji (dio 2/3);
- `MAX_COMMIT_REQUEST_BYTES`, `DUCTUS_PROTOCOL_VERSION`, `DUCTUS_ASYNC_COMMIT_PROTOCOL`: granice rute iz `domain`, da ih `http` čita odavde (ista granica na klijentu i serveru).

## Što ne smije uvoziti

Smije uvoziti samo `settings`, `log`, `metrics`, `domain`, `database` i `external/storage`, i to kroz njihov `index.ts`. `database` i `external/storage` uvozi samo s `import type` (tip porta); adapter mu predaje `http`. Ne uvozi `http`, `contracts` ni `test-server`. S drugim feature područjima dijeli podatke samo kroz bazu i RPC. Popis je u [karti servera, §2](../../docs/server-map.md#2-dopušteni-uvozi); provjera je lint `local/area-boundary`.
