# test-support/fake-services

Lažna pohrana, ključevi i e-pošta za obrazac poziva vanjske usluge (S-1E-c, DAN-837), samo za lokalni rad i CI. Proizvodni kod ne uvozi `test-support/` ([docs/server-map.md](../../docs/server-map.md) §2).

- `createFakeGate({ mode, delayMs?, clock? })`: način rada ispred svakog poziva, iz `@ductura/test-fakes/services` (`ok`, `slow`, `down`). `slow` čeka lažni sat (zadano 30 000 ms), `down` pada kao mrežna greška Nodeova `fetch`. `reached()` broji pozive koji su stigli do usluge.
- `createFakeStorage`: portovi pohrane iz [server/external/storage](../../server/external/storage/README.md) nad `InMemoryEvidencePayloadStore`.
- `createFakeKeys`: `SigningKeyProvider` iz [server/external/keys](../../server/external/keys/README.md) nad kratkotrajnim razvojnim potpisnikom.
- `createFakeEmail`: `EmailSender` iz [server/external/email](../../server/external/email/README.md); poslane poruke su u `sent`.

Prihvat (svaki servis u tri načina, spor servis ne drži poziv dulje od roka, ključevi i lozinke nisu u zapisima) provjerava `fake-services.integration.test.ts`. Svi podaci su izmišljeni (domena `.invalid`).
