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

## Lanac evidencije jednog rada (DAN-1563)

```sh
node scripts/evidence-verify/index.ts --chain <mapa> --public-keys kljucevi.json [--json]
# ili: pnpm evidence:verify --chain <mapa> --public-keys kljucevi.json --json
```

`<mapa>` sadrži `paket.json` i datoteke koje on imenuje (samo imena iz te mape, nikad putanje):

```json
{
  "format": "ductura-evidence-chain-v1",
  "segments": ["odsjecak-1.json", "odsjecak-2.json"],
  "receipts": ["potvrda-1.json", "potvrda-2.json"],
  "head": { "segmentHash": "<sha256 hex>", "segmentCount": 2 },
  "initialDocument": "dokument-0.json",
  "merkle": "merkle-dokaz.json"
}
```

- `segments`: spremljeni bajtovi segmenata redom lanca; `head` je glava koju je poslužitelj zabilježio (`null` za prazan paket).
- `receipts`: jedna potpisana potvrda v2 po segmentu, istim redom.
- `initialDocument`: kanonski početni dokument; `null` znači reviziju 0 formata prvog segmenta (`ductus-edit-steps-v1` ili `-v3`).
- `merkle` (neobavezno): `{ receiptId, index, treeSize, root, proof: [hex], leaves: [hex] | null }`; `leaves` su otisci potvrda tog dana redom zapisnika.
- `kljucevi.json`: popis pouzdanih ključeva (`EvidenceDomainKey`: ključ, domena, svrha, valjanost, opoziv). Dolazi izvan paketa, od ustanove.

Redom, i staje na prvom prekidu: `verifyEvidenceChainV2` (JCS, hash, prethodnik, glava) i nijedan prekid u brojevima događaja ni hashu dokumenta; `verifySignedEvidenceReceiptV2` za svaku potvrdu i usporedba njezinih polja sa segmentom (`segmentHash`, prethodnik, `previousReceiptId`, dokument, raspon, broj događaja, bajtovi, paket, domena); `findEvidenceStartBreakV2` i `replayEvidenceSegmentsV2` s poslužiteljskim replayerom koraka, koji provjerava `removedSha256` svakog uklonjenog raspona (B-12); `evidenceLogRoot` nad `leaves` i `verifyEvidenceLogInclusion` za `receiptId`. Druge implementacije provjere ovdje nema.

Izlaz je kod 0 i redak `ISPRAVNO: …` samo kad sve vrijedi, inače kod 1 i `NEISPRAVNO: <kod> (odsjecak n, dogadaj m, <razlog>)`. S `--json` ispis je jedan objekt `{ ok, problem, at: { segment, sequence, detail }, summary }` na stdout. Ulazni podaci se ne ispisuju, osim hashova i oznaka ključeva u sažetku.

Granice: `treeSize` i korijen dolaze iz paketa, a potpis dnevnog korijena provjerava `--root`; Merkle dokaz koji nije u paketu ispisuje se kao takav. Dokaz dosljednosti dvaju korijena, objava korijena i izvozni paket (DAN-341) nisu dio ovog koraka. Testovi: `chain.test.ts` (i kao stvarni proces).

## Paket evidencije s datotekom povjerenja (DAN-1563, main #789)

Druga, starija izvedba istog zadatka iz `main` (spojena u F4-SYNC): `package.ts` (provjera), `cli.ts` (naredba), testovi `package.test.ts`. Ne zamjenjuje `--chain` iznad; obje ostaju dok vlasnik ne odluči koju zadržati.

Provjera jednog paketa evidencije samo iz datoteka (DAN-1563): bez baze, bez mreže i bez poslužitelja. Sve provjere su pozivi postojećeg koda iz `server/domain/forensics`; ovdje se ništa ne sažima, ne kanonizira i ne provjerava potpis iznova.

```bash
pnpm evidence:package <paket.json> <povjerenje.json> [--json]
```

Izlaz `0`: nijedna provjera nije pala. Izlaz `1`: barem jedna je pala. Izlaz `2`: krivi argumenti ili datoteka koja se ne može pročitati kao JSON.

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

- **Koraci se ne izvode ponovno.** U ovom repou nema izvođača koraka uređivanja, a drugi napisan ovdje bio bi druga implementacija pravila editora. Alat zato ne potvrđuje da koraci iz odsječaka vode od početnog do završnog sažetka dokumenta.
- **Odrezan kraj.** Ako netko ukloni zadnje odsječke zajedno s njihovim potvrdama, ostatak je i dalje valjan lanac. To se vidi samo uz dnevni korijen i poznat broj potvrda, ne iz paketa samog.
- **Prekid niza je pad.** Zabilježeni prekid rednih brojeva ili sažetka dokumenta između odsječaka prijavljuje se kao `NIJE U REDU` s rednim brojem odsječka, i kad je nastao bez ičije namjere. Tumačenje ostaje čovjeku.
- **Veza `previousReceiptId` se ne provjerava.**
- Alat ne govori ništa o autoru ni o sadržaju rada; potvrđuje samo da zapis nije mijenjan nakon potpisa.
