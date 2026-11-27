# @ductura/test-fakes/tsa

Lažni TSA RFC 3161 za ISTR-2 korak 2. **Samo lokalno i u CI-ju (D-09).** Testovi i CI nikad ne zovu stvarni TSA (`docs/plan/ISTR-2-TSA.md` §5 u `ductura/.github`).

- `createTestPki(now)`: novi korijen, posrednik i TSA certifikati (ECDSA P-256, SHA-256) oko trenutka `now`, i to ispravan TSA, istekli TSA, TSA s EKU-om `codeSigning` te strani korijen sa svojim TSA-om. Ključevi nastaju u memoriji pri svakom pozivu; u repou nema ni ključa ni certifikata.
- `createFakeTsa({ mode, pki?, clock? })`: `fetch` bez porta. `genTime` dolazi s lažnog sata. Svaki zahtjev se bilježi u `requests` (`der`, `valid`, `contentType`). Tijelo koje nije DER `TimeStampReq` v1 s otiskom SHA-256 od 32 bajta odbija se statusom `rejection` (`badDataFormat`) i bilježi s `valid: false`.

| Način                 | Odgovor                                              | Očekivani kod porta       |
| --------------------- | ---------------------------------------------------- | ------------------------- |
| `valid`               | ispravan žig                                         | uspjeh                    |
| `rejection`           | `PKIStatus` rejection, bez žiga                      | `TSA_REJECTED`            |
| `wrong-imprint`       | otisak se razlikuje u jednom bajtu                   | `TSA_IMPRINT_MISMATCH`    |
| `wrong-nonce`         | jednokratni broj se razlikuje u jednom bajtu         | `TSA_NONCE_MISMATCH`      |
| `expired-certificate` | potpisuje certifikat istekao prije `genTime`         | `TSA_CERTIFICATE_EXPIRED` |
| `wrong-eku`           | potpisuje certifikat s EKU-om `codeSigning`          | `TSA_EKU`                 |
| `malformed-der`       | 200 s bajtovima koji nisu DER                        | `TSA_MALFORMED`           |
| `timeout`             | nikad ne odgovara; završava samo prekidom zahtjeva   | `TSA_TIMEOUT`             |
| `untrusted-root`      | ispravan žig TSA-a pod korijenom kojem se ne vjeruje | `TSA_CHAIN`               |
| `wrong-ess-cert-id`   | ESSCertIDv2 imenuje drugi certifikat                 | `TSA_ESS_CERT_ID`         |
| `stale-gen-time`      | `genTime` dan prije zahtjeva                         | `TSA_GEN_TIME`            |

Tablicu provjerava `server/external/tsa/golden.integration.test.ts`; sam lažni TSA provjerava `fake-tsa.test.ts`.
