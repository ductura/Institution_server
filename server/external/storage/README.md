# server/external/storage

Pohrana objekata dokaza (S3), karta: [docs/server-map.md](../../../docs/server-map.md). Objekt je adresiran hashom (`v2/<ustanova>/<paket>/<hash>.json`, BACKEND 4.1) i nikad se ne prepisuje; svaka ustanova ima svoju domenu pohrane (bucket), a `storageRef` nosi samo oznaku domene i ključ, nikad endpoint ni bucket.

Preneseno iz Ductusa `src/adapters/evidence` (`d52a92c3`, S-0.19, DAN-732) bez promjene logike; promijenjeni su uvozi, `interface` u `type` (pravilo 4 u [docs/CODE_STYLE.md](../../../docs/CODE_STYLE.md)) i nekoliko izraza koje traži strožji `tsconfig.json` ovog repoa (`noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`).

- `port.ts`: port pohrane iz Ductus `src/application/ports` (samo dio za pohranu): `EvidencePayloadStore`, `EvidencePayloadLocator`, `InstitutionEvidencePayloadReader`, `EvidencePayloadReader`, `EvidencePayloadPresence` i `bindPayloadReader`.
- `evidence-storage-config.ts`: `loadEvidenceStorageConfig`, domene pohrane iz `EVIDENCE_STORAGE_DOMAINS`; greške imenuju varijablu, nikad vrijednost.
- `s3-signature.ts`: AWS SigV4 potpis zahtjeva i zapečaćeni ključevi (`S3SecretCredentials`).
- `s3-evidence-payload-store.ts`: `S3EvidencePayloadStore`, samo `GET`, `HEAD` i uvjetni `PUT` (bez brisanja i višedijelnog prijenosa), provjera identiteta bucketa.
- `institution-routed-payload-store.ts`: `InstitutionRoutedPayloadStore`, usmjerava ustanovu na njezinu domenu; bez domene odgovara `unavailable`, nikad tuđom domenom.
- `in-memory-evidence-payload-store.ts`: zamjena u memoriji za testove i `test-server`.
- `index.ts`: javno sučelje mape.

Pravila ključa (`evidenceObjectKey`, `evidenceStorageRef`, provjere id-ova) su čista pravila u `server/domain/evidence/object-key.ts`. Mapa uvozi samo `domain` i `node:`. Područja osim `http` uvoze je samo s `import type`. `@smithy/signature-v4` je samo razvojna ovisnost za test usporedbe potpisa.
