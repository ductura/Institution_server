# server/domain/forensics

Format i provjera dokaza pisanja: JCS (RFC 8785), segmenti dokaza v2 do v4, lanac segmenata, kontrolne točke i Merkleov zapisnik, potvrde dokaza i predaje te Ed25519 potpisi. Prenesen iz Ductusa `src/domain/forensics` na `d52a92c3` (S-0.19, DAN-732). Risk floor `critical`.

`index.ts` izvozi sve datoteke koda. Testni vektori su u [golden-vectors](golden-vectors/README.md).

Razlike prema Ductusu, samo u testovima:

- `crypto.test.ts` traži pozivatelje stare Merkleove funkcije u mapama ovog repoa (`server`, `scripts`, `test-support`, `tests`, `db`, `infra`).
- `evidence-receipt-v2.test.ts`, `submission-receipt.test.ts` i `submission-receipt-v2.test.ts` uspoređuju vektore s doslovnim redcima Ductusovih dokumenata u `golden-vectors/ductus-docs.txt`, jer ti dokumenti nisu u ovom repou.
- `golden-vectors.test.ts` ne čita Ductusove testove iz `src/application`, koji ovdje ne postoje.
- Tri testa imaju crticu umjesto točke u imenu (`-fuzz`, `-closed-steps`, `-format`), kako traži `local/test-file-suffix`.

Uvozi samo `../document`, `../json` i `node:crypto`.
