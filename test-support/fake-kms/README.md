# test-support/fake-kms

Lažni AWS KMS u memoriji (`FakeKmsClient`) za lokalni rad i CI. Odgovara na tri naredbe koje šalje `AwsSdkKmsEd25519Transport` iz [server/external/keys](../../server/external/keys/README.md) (`Sign`, `Verify`, `GetPublicKey`), s oblicima izlaza i iznimaka AWS SDK-a. Ključevi su kratkotrajni Ed25519 parovi u memoriji procesa; ništa se ne čita s diska ni ne piše na disk. `fault` ubacuje kvar transporta (`network`, `hang`).

Preneseno iz Ductusa `src/adapters/crypto/fake-kms-client.ts` (`d52a92c3`, S-0.19, DAN-732) bez promjene logike. Izdvojeno iz adaptera jer proizvodni adapter ne sadrži lažnog pružatelja, a proizvodni kod ne uvozi `test-support/` ([docs/server-map.md](../../docs/server-map.md) §2). Konstruktor i dalje odbija sve osim `NODE_ENV` `development` ili `test`.

Provjeravaju ga testovi transporta (`server/external/keys/aws-kms-sdk-transport.test.ts`); vlastitog testa nema, kao ni u Ductusu.
