# scripts/evidence-verify

Provjera jednog paketa evidencije samo iz datoteka (DAN-1563): bez baze, bez mreže i bez poslužitelja. Sve provjere su pozivi postojećeg koda iz `server/domain/forensics`; ovdje se ništa ne sažima, ne kanonizira i ne provjerava potpis iznova.

```bash
pnpm evidence:verify <paket.json> <povjerenje.json> [--json]
```

Izlaz `0`: nijedna provjera nije pala. Izlaz `1`: barem jedna je pala. Izlaz `2`: krivi argumenti ili datoteka koja se ne može pročitati kao JSON.

## Dvije datoteke

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

## Što se provjerava

| Provjera   | Što znači `U REDU`                                                                                                                                        |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `package`  | Obje datoteke imaju očekivani oblik.                                                                                                                      |
| `chain`    | Svaki odsječak je kanonski, veže se na sažetak prethodnog, prvi nema prethodnika, a zadnji je onaj na koji se obvezuje zadnja potvrda. Nema prekida niza. |
| `receipts` | Svaku potvrdu potpisao je važeći ključ očekivane domene i ona je potvrda upravo tih bajtova odsječka (sažetak, oznaka, prethodnik, raspon, veličina).     |
| `log`      | Svaka potvrda je u dnevniku čiji je korijen zadan u povjerenju. Bez `log` u povjerenju: `NIJE PROVJERENO`.                                                |
| `replay`   | Uvijek `NIJE PROVJERENO`, vidi granice.                                                                                                                   |

Provjere se ne zaustavljaju na prvoj koja padne; izvještaj uz svaku navodi razlog i redni broj odsječka. `NIJE PROVJERENO` ne dokazuje ništa i ne ruši ishod.

## Poznate granice

- **Koraci se ne izvode ponovno.** U ovom repou nema izvođača koraka uređivanja, a drugi napisan ovdje bio bi druga implementacija pravila editora. Alat zato ne potvrđuje da koraci iz odsječaka vode od početnog do završnog sažetka dokumenta.
- **Odrezan kraj.** Ako netko ukloni zadnje odsječke zajedno s njihovim potvrdama, ostatak je i dalje valjan lanac. To se vidi samo uz dnevni korijen i poznat broj potvrda, ne iz paketa samog.
- **Prekid niza je pad.** Zabilježeni prekid rednih brojeva ili sažetka dokumenta između odsječaka prijavljuje se kao `NIJE U REDU` s rednim brojem odsječka, i kad je nastao bez ičije namjere. Tumačenje ostaje čovjeku.
- **Veza `previousReceiptId` se ne provjerava.**
- Alat ne govori ništa o autoru ni o sadržaju rada; potvrđuje samo da zapis nije mijenjan nakon potpisa.
