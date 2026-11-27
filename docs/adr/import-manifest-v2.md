# ADR: manifest uvoza v2 (tragovi uz PDF i ODT)

F4-PM2-R18 (M8.10), `Risk: critical`.

**Status: PRIJEDLOG.** Dok ovaj dokument ne potvrde review i Ductusova strana ugovora odsječka v4, ne gradi se ništa od navedenoga. `ductus-import-manifest-v1` i [`import-contract.md`](import-contract.md) vrijede bez promjene.

## Kontekst

- M8.10 traži da uvoz PDF-a i ODT-a izvuče tragove, kao što ih DOCX već daje.
- U manifestu v1 trag je samo brojač po vrsti, `{traceKind, count}`. Vrste su `comment`, `deletion` i `insertion`. Bez autora, datuma i povijesti pisanja (D-198 t. 5; [`import-contract.md`](import-contract.md) §2, M1, M15, K8).
- Manifest v1 zabranjuje `traces` uz `pdf`, pa ni prazan niz nije dopušten (M9). `fileFormat` je samo `docx` ili `pdf`. Tablica `collaboration.import_event` ima `CHECK (file_format IN ('docx','pdf'))`.
- Oblik manifesta zadaje Ductusov ugovor odsječka v4, a golden vektori su bajt po bajt isti u oba repoa. Tragovi uz PDF u v1 bili bi prijelomna promjena: stari čitači odbili bi takav manifest s `MANIFEST_INVALID`.

Odluka vlasnika od 27. 11. 2026. je preporuka A: novi ugovor manifesta, pa migracija, pa čitač ODT-a, pa tragovi u PDF-u. Svaki korak je zaseban zadatak.

## Odluka (prijedlog)

### 1. Nova shema `ductus-import-manifest-v2`

Pisac ostaje isti: manifest i dalje stvara samo poslužitelj. Čitač prihvaća i v1 i v2, a `manifestSchema` određuje pravila. Nijedan v1 manifest se ne mijenja ni ne prepisuje. Njegov `manifestSha256` ostaje isti.

Razlike prema v1:

| Polje                 | v1                            | v2                          |
| --------------------- | ----------------------------- | --------------------------- |
| `manifestSchema`      | `ductus-import-manifest-v1`   | `ductus-import-manifest-v2` |
| `fileFormat`          | `docx`, `pdf`                 | `docx`, `pdf`, `odt`        |
| `traces` uz `docx`    | obvezan, može biti `[]`       | isto                        |
| `traces` uz `pdf`     | zabranjen                     | obvezan, može biti `[]`     |
| `traces` uz `odt`     | —                             | obvezan, može biti `[]`     |
| `importKind` uz `odt` | —                             | samo `file-upload`          |
| `savedAt`             | samo `cloud-version` + `docx` | isto                        |

Element traga je isti kao u v1: `{traceKind, count}`, `count ≥ 1`, najviše tri elementa, svaka vrsta jednom, kanonskim redom. Kanonski oblik, red ključeva i tri hasha računaju se kao u v1.

### 2. Što se broji

| Format | `comment`                                                                                     | `deletion`                              | `insertion`                              |
| ------ | --------------------------------------------------------------------------------------------- | --------------------------------------- | ---------------------------------------- |
| DOCX   | bez promjene (v1)                                                                             | bez promjene                            | bez promjene                             |
| ODT    | `office:annotation` u `content.xml` (bez `office:annotation-end`)                             | `text:changed-region` s `text:deletion` | `text:changed-region` s `text:insertion` |
| PDF    | anotacije `/Annot` podtipa `Text` i `FreeText` (`Popup` se ne broji jer pripada roditeljskoj) | nikad                                   | nikad                                    |

PDF nema praćene promjene, pa `deletion` i `insertion` u PDF-u ne postoje. Čitač ih ne pogađa iz izgleda stranice.

Ne čita se ništa od ovoga: autor (`dc:creator`, `/T`), datum (`dc:date`, `/M`, `/CreationDate`), sadržaj komentara (`/Contents`, tekst unutar `office:annotation`) ni naziv datoteke. Pravila M1, M15 i K8 vrijede i za nove formate.

### 3. B3 i kodovi odbijanja

Poslužitelj tragove računa sam iz primljenih bajtova. Razlika prema klijentovom manifestu daje `TRACES_MISMATCH`, kao u v1. Novih kodova nema.

### 4. Redoslijed (svaki je zaseban zadatak i PR)

1. **Ugovor**: Ductus i SRV objavljuju shemu v2 u ugovoru odsječka v4, zajedno s golden vektorima za `odt` i za `pdf` s tragovima. U SRV-u: `server/contracts/import/manifest.ts` dobiva `ImportManifestV2`, a čitač vraća uniju v1 i v2. Testovi M7–M9 dobivaju v2 parove: v1 i dalje odbija `traces` uz `pdf`, a v2 ga traži.
2. **Migracija** (val 2, ODOBRENO): `CHECK (file_format IN ('docx','pdf','odt'))` na `collaboration.import_event`, uz retke u pgTAP matrici. Postojeća migracija se ne mijenja; nova zamjenjuje ograničenje.
3. **Čitač ODT-a** (`server/import/odt/`): ZIP i `content.xml`, uz iste granice čitanja kao DOCX (B-8, broj unosa, raspakirana veličina i dubina XML-a). Daje tekst i tragove.
4. **Tragovi u PDF čitaču** (`server/import/pdf/`): broji `/Annot` podtipa `Text` i `FreeText`, uz granicu broja anotacija po stranici i ukupno.

Koraci 2–4 ne počinju prije koraka 1.

## Posljedice

- `manifestSha256` za iste bajtove razlikuje se između v1 i v2 jer je shema drugačija. Pri uvozu poslužitelj zapisuje samo v2, a stari zapisi ostaju v1.
- WEB prikazuje tragove za PDF i ODT jednako kao za DOCX.
- Ductusov čitač mora prihvaćati v2 prije nego što SRV počne zapisivati v2. To je uvjet za korak 3 i 4.

## Otvoreno za review

1. Treba li v2 uz `pdf` dopustiti i `cloud-version`? Prijedlog: ne, jer za PDF nema verzija u oblaku.
2. Treba li uz PDF brojati i označavanja (`Highlight`, `StrikeOut`, `Underline`)? Prijedlog: ne, jer nisu komentar ni praćena promjena. Ostaje za kasniju verziju.
3. Treba li za ODT podržati i `.fodt` (ravni XML)? Prijedlog: ne, jer sučelje nudi samo `.odt`.
