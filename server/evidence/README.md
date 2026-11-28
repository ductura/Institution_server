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
- `readReplayPage({ source, payloads, resolutions }, documentId, from, pin)`, `REPLAY_FORMAT`, `MAX_REPLAY_PAGE_SEGMENTS` i tipovi `ReplayPage`, `ReplayReadResult`, `ReplayReaderDeps`, `ReplayResolution` (`replay.ts`, DAN-818, prijenos Ductus `replay-reader.ts` na `333e163`): jedna stranica replaya s provjerenim spremljenim bajtovima segmenata. Server ne izvodi korake (B-12 na serveru je DAN-819); svaki kvar je cijeli, nikad djelomična stranica. Od API 1.193.0 (F4-EDI-R05-SRV B2) stranica nosi i `resolutions`, po pravilu za `keep_local` niže;
- `createSignPendingReceipt({ signer, store, checkObject, signTimeoutMs })` i tipovi `SignPendingReceiptDeps`, `SignPendingReceiptOutcome`, `PendingReceiptObjectCheck`, `PendingReceiptHold` (`sign-pending-receipt.ts`, DAN-820 820c, prijenos Ductus `sign-pending-receipt.ts` na `333e163`): potpis jedne pending potvrde v2. Redom: tekst (`pending-receipt-text.ts`), sažetak, ključevi domene, provjera objekta segmenta, potpisnik s rokom (`sign-within.ts`), provjera potpisa provjeriteljem protokola 1 s ključem iz registra domene i upis kroz spremište čiji se odgovor provjerava (`settle-attach.ts`). Ishodi su zatvoreni kodovi `status`/`reason` za worker, ne greške sučelja. Proces workera i provjera objekta (DAN-301) predaju se kao portovi; worker još ne postoji (dio 2/3);
- `decideSignatureRetry(reply, attempt, policy, random)`, `signatureRetryDelayMs(attempt, policy, random)`, `MAX_SIGNATURE_RETRY_ATTEMPTS` (10), `MAX_SIGNATURE_RETRY_DELAY_MS` (300 000) i tipovi `SignatureRetryPolicy`, `SignatureRetryDecision`, `SignatureParkReason` (`signature-retry.ts`, DAN-822-1, prijenos Ductus `signature-retry.ts` na `b36c82b`): odluka nakon jednog pokušaja potpisa. Gotovo je samo `signed` ili `already_signed`; odbijanje, zadržavanje, odbijen potpisnik i kvar sažetka odmah ostavljaju potvrdu pending, a sve ostalo se ponavlja do `maxAttempts` (najviše 10) s rastućim čekanjem i jitterom.;
- `createSignPendingReceiptWithRetry({ signPendingReceipt, policy, sleep, random })` i tipovi `SignatureRetryDeps`, `SignatureRetryResult` (`signature-retry.ts`, DAN-822-2, isti izvor): petlja pokušaja nad `createSignPendingReceipt`. Svaki pokušaj dobiva kopiju retka snimljenog na početku; čeka samo kroz predani `sleep`, a odbijen `sleep` (gašenje) ostavlja potvrdu pending kao `interrupted`. Rezultat `parked` nosi samo brojeve i stage, nikad id, tekst ni potpis; `done` nosi potpisanu potvrdu. Svojstveni test pod prekidima (`signature-retry-interruption.property.test.ts`, DAN-822-3) drži jedan deterministički potpis uz drugog potpisnika i izgubljen odgovor spremišta;
- `MAX_COMMIT_REQUEST_BYTES`, `DUCTUS_PROTOCOL_VERSION`, `DUCTUS_ASYNC_COMMIT_PROTOCOL`: granice rute iz `domain`, da ih `http` čita odavde (ista granica na klijentu i serveru).
- `MAX_DOCUMENT_SNAPSHOT_BYTES`, `verifyDocumentSnapshot` i tip `DocumentSnapshotVerification`: provjera snimke živog prikaza iz `domain` (točni JCS bajtovi valjanog dokumenta, najviše 2 MiB), da je `http` (`live.ts`) čita odavde.

## Pravilo za `keep_local` (F4-EDI-R05-SRV)

Razrješenje sukoba „zadrži tekst s ovog uređaja” je obična revizija N (docs/vs1-rute.md). Kad je commit poslan s razrješenjem `{"kind":"keep_local","conflictBaseRevision":M}`, baza uz reviziju N sprema i M (B1, `evidence.revision_resolution`):

- `keep_local` znači: uređaj je zadržao svoj tekst, koji je počeo od revizije M, preko revizija M + 1 … N − 1 drugog uređaja. Te revizije ostaju u lancu nepromijenjene; razrješenje ništa ne briše ni ne prepisuje.
- Uvijek vrijedi 0 ≤ M < N. Jedna revizija ima najviše jedno razrješenje, i ono se poslije ne mijenja.
- Replay (`readReplayPage`, od API 1.193.0) za svaki segment na stranici čija je revizija razriješila sukob vraća `resolutions[<hash segmenta>] = {kind: "keep_local", conflictBaseRevision: M}`. Segment bez unosa nije razriješio sukob. Unos postoji samo za segment na toj stranici, do glave na koju je stranica vezana.
- Razrješenja se čitaju nakon popisa zapisa, kroz iste čitatelje i isti presjek predaje (`app.read_replay_resolutions`). Vlasnik i nastavnik zadatka dobivaju iste bajtove (PRODUCT §5 pravilo 5).
- Ako se razrješenja ne mogu pročitati ili je redak neispravan, cijela stranica je 503 `context`. Stranica bez razrješenja koja ih ima nikad ne izlazi.

## Što ne smije uvoziti

Smije uvoziti samo `settings`, `log`, `metrics`, `domain`, `database` i `external/storage`, i to kroz njihov `index.ts`. `database` i `external/storage` uvozi samo s `import type` (tip porta); adapter mu predaje `http`. Ne uvozi `http`, `contracts` ni `test-server`. S drugim feature područjima dijeli podatke samo kroz bazu i RPC. Popis je u [karti servera, §2](../../docs/server-map.md#2-dopušteni-uvozi); provjera je lint `local/area-boundary`.
