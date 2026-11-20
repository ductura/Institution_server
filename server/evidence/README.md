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
- `decideSignatureRetry(reply, attempt, policy, random)`, `signatureRetryDelayMs(attempt, policy, random)`, `MAX_SIGNATURE_RETRY_ATTEMPTS` (10), `MAX_SIGNATURE_RETRY_DELAY_MS` (300 000) i tipovi `SignatureRetryPolicy`, `SignatureRetryDecision`, `SignatureParkReason` (`signature-retry.ts`, DAN-822-1, prijenos Ductus `signature-retry.ts` na `b36c82b`): odluka nakon jednog pokušaja potpisa. Gotovo je samo `signed` ili `already_signed`; odbijanje, zadržavanje, odbijen potpisnik i kvar sažetka odmah ostavljaju potvrdu pending, a sve ostalo se ponavlja do `maxAttempts` (najviše 10) s rastućim čekanjem i jitterom.;
- `createSignPendingReceiptWithRetry({ signPendingReceipt, policy, sleep, random })` i tipovi `SignatureRetryDeps`, `SignatureRetryResult` (`signature-retry.ts`, DAN-822-2, isti izvor): petlja pokušaja nad `createSignPendingReceipt`. Svaki pokušaj dobiva kopiju retka snimljenog na početku; čeka samo kroz predani `sleep`, a odbijen `sleep` (gašenje) ostavlja potvrdu pending kao `interrupted`. Rezultat `parked` nosi samo brojeve i stage, nikad id, tekst ni potpis; `done` nosi potpisanu potvrdu. Svojstveni test pod prekidima (`signature-retry-interruption.property.test.ts`, DAN-822-3) drži jedan deterministički potpis uz drugog potpisnika i izgubljen odgovor spremišta;
- `MAX_COMMIT_REQUEST_BYTES`, `DUCTUS_PROTOCOL_VERSION`, `DUCTUS_ASYNC_COMMIT_PROTOCOL`: granice rute iz `domain`, da ih `http` čita odavde (ista granica na klijentu i serveru).
- `MAX_DOCUMENT_SNAPSHOT_BYTES`, `verifyDocumentSnapshot` i tip `DocumentSnapshotVerification`: provjera snimke živog prikaza iz `domain` (točni JCS bajtovi valjanog dokumenta, najviše 2 MiB), da je `http` (`live.ts`) čita odavde.

## Što ne smije uvoziti

Smije uvoziti samo `settings`, `log`, `metrics`, `domain`, `database` i `external/storage`, i to kroz njihov `index.ts`. `database` i `external/storage` uvozi samo s `import type` (tip porta); adapter mu predaje `http`. Ne uvozi `http`, `contracts` ni `test-server`. S drugim feature područjima dijeli podatke samo kroz bazu i RPC. Popis je u [karti servera, §2](../../docs/server-map.md#2-dopušteni-uvozi); provjera je lint `local/area-boundary`.
