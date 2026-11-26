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

## Paket evidencije (DAN-1563)

```sh
node scripts/evidence-verify/index.ts --package <paket.json> --trust <povjerenje.json> [--json]
# ili: pnpm evidence:verify --package <paket.json> --trust <povjerenje.json> [--json]
```

Provjera jednog paketa evidencije samo iz datoteka: bez baze, bez mreže i bez poslužitelja. Sve provjere su pozivi postojećeg koda iz `server/domain/forensics`; ovdje se ništa ne sažima, ne kanonizira i ne provjerava potpis iznova. Implementacija: `package.ts` (provjera) i `package-cli.ts` (naredbeni redak).

Izlaz `0`: nijedna provjera nije pala. Izlaz `1`: barem jedna je pala. Izlaz `2`: krivi argumenti (`Upotreba: …`) ili datoteka koja se ne može pročitati kao UTF-8 JSON (`NEISPRAVNO: file_unreadable`) ili je prevelika (`NEISPRAVNO: file_too_large`). Sadržaj i putanje datoteka se ne ispisuju. `--json` ispisuje izvještaj kao JSON umjesto teksta.

### Dvije datoteke

**Paket** predaje strana koja se provjerava:

```json
{
  "packageSchema": "ductura-evidence-verify-package-v1",
  "segments": ["<kanonski JCS tekst odsječka>", "..."],
  "receipts": [{ "payload": {}, "payloadDigestSha256": "...", "signature": {} }],
  "inclusions": [{ "index": 0, "proofHex": ["..."] }]
}
```

`segments` i `receipts` idu istim redom, jedna potpisana potvrda v2 po odsječku. `inclusions` je neobavezan; treba ga samo uz dnevni korijen.

**Povjerenje** donosi strana koja provjerava i nikad se ne čita iz paketa:

```json
{
  "evidenceDomainId": "<UUID v4>",
  "keys": [
    {
      "algorithm": "Ed25519",
      "keyId": "...",
      "keyVersion": "1",
      "encoding": "spki-der",
      "keyBase64Url": "...",
      "evidenceDomainId": "...",
      "purpose": "receipt",
      "validFrom": "...",
      "validTo": null,
      "revokedAt": null
    }
  ],
  "log": { "treeSize": 2, "rootHex": "..." }
}
```

`log` je neobavezan: objavljeni korijen dnevnika potvrda i njegova veličina.

### Što se provjerava

| Provjera   | Što znači `U REDU`                                                                                                                                        |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `package`  | Obje datoteke imaju očekivani oblik.                                                                                                                      |
| `chain`    | Svaki odsječak je kanonski, veže se na sažetak prethodnog, prvi nema prethodnika, a zadnji je onaj na koji se obvezuje zadnja potvrda. Nema prekida niza. |
| `receipts` | Svaku potvrdu potpisao je važeći ključ očekivane domene i ona je potvrda upravo tih bajtova odsječka (sažetak, oznaka, prethodnik, raspon, veličina).     |
| `log`      | Svaka potvrda je u dnevniku čiji je korijen zadan u povjerenju. Bez `log` u povjerenju: `NIJE PROVJERENO`.                                                |
| `replay`   | Uvijek `NIJE PROVJERENO`, vidi granice.                                                                                                                   |

Provjere se ne zaustavljaju na prvoj koja padne; izvještaj uz svaku navodi razlog i redni broj odsječka. `NIJE PROVJERENO` ne dokazuje ništa i ne ruši ishod.

### Poznate granice

- **Koraci se ne izvode ponovno.** Paket v1 ne nosi početni dokument ni izvođača koraka svog formata transakcije, pa alat ne potvrđuje da koraci iz odsječaka vode od početnog do završnog sažetka dokumenta (razlog `replay_not_in_package`). Ponovno izvođenje na ovoj bazi postoji samo u rekonstrukciji poslužitelja (`server/evidence/reconstruction`, `replayEvidenceSegmentsV2`); da ga izvanmrežna provjera dobije, treba nova verzija paketa.
- **Odrezan kraj.** Ako netko ukloni zadnje odsječke zajedno s njihovim potvrdama, ostatak je i dalje valjan lanac. To se vidi samo uz dnevni korijen i poznat broj potvrda, ne iz paketa samog.
- **Prekid niza je pad.** Zabilježeni prekid rednih brojeva ili sažetka dokumenta između odsječaka prijavljuje se kao `NIJE U REDU` s rednim brojem odsječka, i kad je nastao bez ičije namjere. Tumačenje ostaje čovjeku.
- **Veza `previousReceiptId` se ne provjerava.**
- Alat ne govori ništa o autoru ni o sadržaju rada; potvrđuje samo da zapis nije mijenjan nakon potpisa.
