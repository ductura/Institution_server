# server/external/keys

Port potpisa i ključeva (KMS), karta: [docs/server-map.md](../../../docs/server-map.md). Materijal privatnog ključa u produkciji ne napušta AWS KMS (D-71); aplikacija dobiva potpis, nikad ključ. Cijela mapa ima floor `critical`.

Preneseno iz Ductusa `src/adapters/crypto` i porta `src/application/ports/signing-key-provider.ts` (`d52a92c3`, S-0.19, DAN-732) bez promjene logike; promijenjeni su samo uvozi, `interface` u `type` (pravilo 4 u [docs/CODE_STYLE.md](../../../docs/CODE_STYLE.md)) i tipovi ulaza lažnog KMS-a za `exactOptionalPropertyTypes`. Lažni KMS (`FakeKmsClient`) je izdvojen u [test-support/fake-kms](../../../test-support/fake-kms/README.md), jer proizvodni adapter ne sadrži lažnog pružatelja (karta, §2).

- `signing-key-provider.ts`: port `SigningKeyProvider` (`sign`, `verify`, `publicVerificationKey`); tipovi potpisa dolaze iz `server/domain`.
- `aws-kms-ed25519-signer.ts`: `AwsKmsEd25519SigningKeyProvider`, proizvodni potpisnik nad ključem `ECC_NIST_EDWARDS25519` (`ED25519_SHA_512`, poruka `RAW`). Potpisuje i provjerava samo s verzijama ključa s popisa povjerenja; `keyVersion` u omotnici je nepovjerljiv ulaz.
- `aws-kms-sdk-transport.ts`: `AwsSdkKmsEd25519Transport` nad službenim SDK-om (`@aws-sdk/client-kms`), rok za svaki poziv i zatvoren skup grešaka `KmsTransportError` (poruka bez ID-a i ARN-a ključa). Ne čita okolinu.
- `development-ed25519-signer.ts`: `DevelopmentEd25519SigningKeyProvider`, kratkotrajni ključ u memoriji procesa.
- `persistent-development-ed25519-signer.ts`: `PersistentDevelopmentEd25519SigningKeyProvider`, razvojni ključ iz datoteke sjemena (`DUCTUS_DEV_SIGNING_KEY_FILE`, apsolutna putanja izvan repozitorija, prava `0600`); nikad ga ne stvara.
- `index.ts`: javno sučelje mape.

Zaštite: oba razvojna potpisnika (i lažni KMS u `test-support/fake-kms`) odbijaju se stvoriti ako `NODE_ENV` nije `development` ili `test` (popis dopuštenih; nepostavljen, prazan ili krivo napisan znači produkciju). Kad nastane `server/settings`, ono uz to odbija razvojni potpisnik izvan lokalnog rada i CI-ja (karta, §1).

Testovi su uz kod. Mapa uvozi samo `server/domain` (tipovi), `@aws-sdk/client-kms` i `node:`; prema karti smije još `settings`, `log` i `metrics`. Područja osim `http` uvoze je samo s `import type`. Sastavljanje (`KMSClient`, regija, vjerodajnice) dolazi sa sastavljačem u `http`.
