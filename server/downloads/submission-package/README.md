# server/downloads/submission-package

Poveznica od 24 sata na izvozni paket predanog rada i na potvrdu za referadu, u području [preuzimanja](../README.md) (SRV-1807; plan M8.6; R-05, R-06, D-173).

## Što radi

`issuePackageLink` izdaje poveznicu za jednu predaju i jednu vrstu, koja vrijedi 24 sata od izdavanja (`PACKAGE_LINK_TTL_MS`). Poveznica nosi vlastiti istek i MAC (HMAC-SHA256) nad predajom, vrstom i istekom, s ključem sesije koja ju je tražila: ne može se prenijeti na drugu predaju, vrstu ni sesiju, a istek se ne može produljiti. `checkPackageLink` vraća `valid`, `expired` ili `invalid`. Sat je argument, ne čita se ovdje.

`buildSubmissionPackage` oba izlaza gradi iz jedne provjerene gradnje prenosivog zapisa (`../portable-record`), pa koriste iste pohranjene vrijednosti predaje i ista provjera ih potvrđuje; ništa se ne generira iznova pri preuzimanju:

| Vrsta      | Sadržaj                                                                                                                                                    |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `package`  | prenosivi zapis (`prenosivi-zapis.zip`): njegov `manifest.json` je jedini manifest D-173, a raspakiranu mapu provjerava `scripts/evidence-verify --record` |
| `referada` | PDF potvrde predaje (`potvrda-za-referadu.pdf`): oznaka predaje, vremena, otisak rada i QR; tekst rada nije u njemu (R-06)                                 |

## Tko ga zove

`server/http/export/submission-package.ts` (rute `student.submission-package-link.post` i `student.submission-package.get`).

## Koje podatke dira

Samo ulaz funkcija. Ne otvara bazu, pohranu ni mrežu.

## Što izvozi

`issuePackageLink`, `checkPackageLink`, `buildSubmissionPackage`, `PACKAGE_KINDS`, `PACKAGE_LINK_TTL_MS`, `REFERADA_CONFIRMATION_FILENAME` i tipove (`index.ts`).

## Što ne smije uvoziti

Vrijede rubovi iz [karte servera](../../../docs/server-map.md): `domain` kroz `index.ts`; drugu mapu područja ne uvozi osim `../portable-record`.

## Otvorene stavke

- Poveznica je vezana uz sesiju koja ju je tražila i vrijedi dok je ta sesija živa; poveznica koja nadživi sesiju, za referadu i bivšeg studenta bez računa (D-271 MQ02, M10.5), traži pohranjeno stanje (tablica, RPC, pgTAP) i druga je traka.
- Paket je prenosivi zapis: DOCX i PDF samog rada nisu u njemu (M8.4 izvozi ih zasebno), a `otisci.sha256` paketa za Merlin (SRV-1110) ostaje svoj format.
