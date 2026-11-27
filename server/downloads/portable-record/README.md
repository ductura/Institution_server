# server/downloads/portable-record

Prenosivi zapis predaje u području [preuzimanja](../README.md) (SRV-1312; plan M7.10; D-49, A-07, D-173, D-263 Q24).

## Što radi

`buildPortableRecord` gradi deterministički ZIP jedne predaje: isti podaci daju iste bajtove (zapisi bez sažimanja, fiksno vrijeme, fiksan redoslijed). U korijenu ZIP-a su:

| Datoteka                     | Sadržaj                                                                                                                                                           |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `manifest.json`              | JCS `{ format, submissionId, dailyRoot, files }`: svaka druga datoteka s veličinom i SHA-256 (manifest s otiscima, D-173)                                         |
| `potvrda.json`               | JCS potpisane potvrde predaje V2, kakvu je student dobio                                                                                                          |
| `kljuc-potvrde.json`         | JCS javnog ključa potvrde s valjanošću (`EvidenceDomainKey`)                                                                                                      |
| `rad.json`                   | točni bajtovi predanog teksta; njihov SHA-256 je `artifactSha256` potvrde                                                                                         |
| `potvrda-predaje.pdf`        | PDF potvrde (`renderReceiptPdf`), isti kao `student.receipt-pdf.get`: uz vezani kod potvrde QR nosi `/provjera#k={kod}` i kod je ispisan ispod njega (Dizajn 1.1) |
| `dnevni-korijen.json`        | spremljeni potpisani dnevni korijen dana potvrde (SRV-1311), samo kad postoji                                                                                     |
| `kljuc-dnevnog-korijena.pem` | javni Ed25519 ključ dnevnog korijena (SPKI PEM), uz korijen                                                                                                       |
| `merkle-dokaz.json`          | JCS `{ entry, index, treeSize, proof }`: unos potvrde u stablu tog dana, uz korijen                                                                               |

Prije pisanja sve se provjerava istim funkcijama kao pri provjeri: potvrda mora biti svoj JCS, imati spremljeni digest i potpis ključem koji baza navodi; tekst mora dati `artifactSha256`; unosi dana moraju dati korijen i sadržavati unos potvrde. Inače je odgovor zatvoreni kod (`PortableRecordRefusal`) bez ikakve vrijednosti zapisa.

Unos predaje u dnevniku evidencije je `{ receiptId: submissionId, acceptedAt: signedAt do milisekunde, digest: payloadDigestSha256 }` (`submissionLogEntry`), u obliku unosa SRV-1311.

`verifyPortableRecord` provjerava raspakirani zapis bez mreže i baze: manifest i otisci, potpis potvrde, otisak teksta (promjena jednog bajta teksta ruši provjeru), a uz dnevni korijen njegov potpis (`DailyRootCheck`, format SRV-1311, predaje ga CLI) i Merkle dokaz za vlastiti unos potvrde. Pokreće je `scripts/evidence-verify --record <mapa>`.

Dnevni korijen daje izvor `PortableDailyRootSource`. Dok worker ne sprema dnevne korijene i ne postoji čitač unosa dana (otvoreno u SRV-1311), ruta koristi `PENDING_DAILY_ROOT`, pa manifest kaže `pending`.

## Tko ga zove

Ruta `student.portable-record.get` (`server/http/portable-record`) i CLI `scripts/evidence-verify`.

## Koje podatke dira

Samo ulaz funkcija. Ne otvara bazu, pohranu ni mrežu.

## Što izvozi

`buildPortableRecord`, `verifyPortableRecord`, `submissionLogEntry`, `logEntryDay`, `PENDING_DAILY_ROOT`, konstante imena i granica (`PORTABLE_RECORD_FILES`, `PORTABLE_RECORD_FILENAME`, `PORTABLE_RECORD_FORMAT`, `DAILY_ROOT_FILES`, `MAX_PORTABLE_RECORD_FILE_BYTES`) i tipove (`index.ts`).

## Što ne smije uvoziti

Vrijede rubovi iz [karte servera](../../../docs/server-map.md): `domain` kroz `index.ts`; ne uvozi `evidence`, pa potpis dnevnog korijena provjerava pozivatelj.
