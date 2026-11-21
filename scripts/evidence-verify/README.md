# scripts/evidence-verify

Provjera potpisanog dnevnog korijena evidencije bez mreže i baze (SRV-1311; plan M3.9, B5).

```sh
node scripts/evidence-verify/index.ts --root root.json --entries entries.ndjson --public-key key.pem
# ili: pnpm evidence:verify --root root.json --entries entries.ndjson --public-key key.pem
```

- `root.json`: spremljeni zapis dana `{ day, root, count, keyId, signature }` (objekt `evidence-daily-root` iz pohrane).
- `entries.ndjson`: unosi tog dana, jedan JSON objekt `{ receiptId, acceptedAt, digest }` po retku, bilo kojim redoslijedom; prazni retci i CRLF su dopušteni.
- `key.pem`: javni Ed25519 ključ (SPKI PEM) kojim je dan potpisan.

Izlaz je kod 0 i redak `ISPRAVNO: …` kad je zapis potpisan tim ključem i obuhvaća točno te unose, inače kod 1 i redak `NEISPRAVNO: <kod>` (`DailyRootProblem` iz `server/evidence/daily-root` ili `usage`, `file_unreadable`, `file_too_large`). Izmijenjen, izbačen ili dodan unos i krivi ključ uvijek daju 1. Ulazni podaci se nikad ne ispisuju.

Provjera je ista funkcija koju posao koristi prije spremanja (`verifyDailyRoot`). Vanjski žig vremena (RFC 3161) nije dio ovog koraka. Testovi: `verify.test.ts` (i kao stvarni proces).

## Prenosivi zapis predaje (SRV-1312)

```sh
node scripts/evidence-verify/index.ts --record <mapa>
# ili: pnpm evidence:verify --record <mapa>
```

`<mapa>` je raspakirani ZIP iz `student.portable-record.get` (`prenosivi-zapis.zip`). Provjera je `verifyPortableRecord` iz `server/downloads/portable-record`: manifest i otisci svih datoteka, potpis potvrde predaje ključem iz `kljuc-potvrde.json`, otisak teksta `rad.json` prema `artifactSha256` potvrde (promjena jednog bajta teksta daje 1), a kad je dan zatvoren i potpis dnevnog korijena (`dnevni-korijen.json`, ključ `kljuc-dnevnog-korijena.pem`, isti format i potpisni ulaz kao gore) i Merkle dokaz (`merkle-dokaz.json`) za unos te potvrde. Ništa izvan mape se ne čita, ni mreža ni baza.

Izlaz je kod 0 i redak `ISPRAVNO: predaja …, kljuc potvrde …, dnevni korijen …` ili kod 1 i `NEISPRAVNO: <kod>` (`PortableRecordProblem`, `usage`, `file_unreadable`). Ključeve u zapisu donosi sam zapis: da su to ključevi ustanove, potvrđuje usporedba ispisanih oznaka ključeva s objavljenim ključevima ustanove ili javna provjera potvrde iz QR-a. Testovi: `portable-record.test.ts` (i kao stvarni proces).
