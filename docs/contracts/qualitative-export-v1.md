# Izvoz kvalitativnog kodiranja v1 (`qualitative-export-v1`)

Zadatak: SRV-V18-KODIRANJE-OZNAKE `srv-v18-kodiranje-oznake` (Ductus#2058, nalog c.7173853108; val 18, `docs/nalazi/val18-razlika.md` u WEB repou, §5 zadatak 8, nalazi V18-4, V18-6, V18-8, V18-9). Ruta: `student.qual-export.get`, `GET /api/v1/student/qual/export`, pristup `student`, API 1.147.0, aditivno. Oblik gradi `buildQualitativeExport` u `server/domain/qualitative-coding/export.ts`, čisto: isti ulaz daje iste bajtove.

Izvoz je **opis za nošenje**, ne presuda: nema ocjene, ranga ni usporedbe gradiva. JSON je jedini oblik s poslužitelja; CSV iz njega piše web (V18-6; ugovorni format nema tekstualno tijelo), isto kao za upitnik.

## Tko ga čita

Samo vlasnik (V18-9). Drugi student i nastavnik ne dobivaju tuđe kodiranje: svoj izvoz (bez ičega od tuđeg) čitaju kao i svatko, a `materialId` tuđeg gradiva je 404, kao nepoznat i neispravan (C-23).

## Zahtjev

`GET /api/v1/student/qual/export`, bez tijela. Neobavezni upit `materialId` (UUID): tada su `segments` i `counts` samo tog gradiva; `codebook` je uvijek cijeli šifrarnik. Drugi upit ili upit dvaput je 422. Odgovor `200` nosi `cache-control: no-store`; greške su 401 `unauthorized`, 404 `not_found` i 503 `unavailable`.

## Odgovor

```json
{
  "schema": "qualitative-export-v1",
  "codebook": [
    {
      "code": "…uuid…",
      "name": "Odnos prema mentoru",
      "description": "Odlomci o odnosu s mentorom."
    },
    { "code": "…uuid…", "name": "Vrijeme i rokovi", "description": "" }
  ],
  "segments": [
    {
      "material": "…uuid…",
      "code": "…uuid…",
      "paragraph": 0,
      "start": 0,
      "end": 10,
      "quote": "Izmišljena",
      "memo": "Izmišljena napomena."
    }
  ],
  "counts": [{ "code": "…uuid…", "material": "…uuid…", "n": 1 }]
}
```

- `codebook[{code, name, description}]`: šifrarnik u redoslijedu koji je odredio student; `description` je prazan niz kad ga nema.
- `segments[{material, code, paragraph, start, end, quote, memo}]`: označeni odlomci; `memo` je `null` kad ga nema. Pomaci su u znakovima, kao u [qualitative-segments-v1.md](qualitative-segments-v1.md).
- `counts[{code, material, n}]`: koliko je odlomaka s kojim kodom u kojem gradivu (`n` ≥ 1; parova bez odlomaka nema).

## Redoslijed (V18-8)

`segments` i `counts` idu po **šifrarniku**, zatim po **gradivu** (redom kako je pohranjeno, najranije prvo), zatim po **tekstu** (`paragraph`, `start`, `end`). **Nikad po `n`**: nema poretka po broju, nema „najčešće” i nema usporedbe gradiva. Premještanje koda u šifrarniku premješta njegove odlomke u izvozu.

## Ponovljivost

Isto kodiranje daje iste bajte: nema vremena, nasumičnog redoslijeda ni identifikatora izvoza u odgovoru. Potvrđuje test `server/http/qualitative-segments.pg.integration.test.ts`.

## Što izvoz ne radi

- ne zove pomoćnika i ne predlaže kodove (V18-3);
- ne šalje podatke nikamo (nema statističkog servisa; slanje je za val 15, V18-5);
- ne daje zbroj, rang ni ocjenu po osobi ni po gradivu;
- ne dijeli kodiranje s nastavnikom ili mentorom (OP-V18-5).
