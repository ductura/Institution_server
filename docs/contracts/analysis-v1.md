# Ugovor analize v1 (SRV-V15-UGOVOR)

Izvor: val 15, `docs/nalazi/val15-razlika.md` §3 (WEB repo), Ductus#2055 c.7163756092. Samo ugovor: izračun (SRV-V15-IZVRSITELJ) i HTTP adapter iza zastavice (SRV-V15-HTTP) slijede. API 1.135.0.

- `analysis.catalogue.get` GET `/api/v1/analysis/catalogue`: analize (`descriptive`, `frequencies`, `correlation`), njihove verzije i ograničenja skupa (500 redaka, 12 stupaca, 64 znaka u ćeliji, 131072 bajta tijela).
- `analysis.runs.post` POST `/api/v1/analysis/runs`: izračun nad skupom iz tijela. Bez stanja i bez zapisa; skup se ne pohranjuje ni ne ulazi u dnevnik.
- Dok je funkcija isključena (zadano), obje rute odgovaraju 404 `not_found`.
- Isti `analysisVersion` i isti skup (isti retci, isti poredak stupaca) daju isti `result`, `datasetSha256` i `resultSha256`. Redoslijed redaka ne mijenja rezultat.
- Odgovor nema identitet osobe, ocjenu, rang ni usporedbu osoba.
- Nova greška: 422 `unknown_analysis_version`.

Odstupanje od dokumenta: skup je u tijelu spljošten (`columns`, `rows`), a ne u `dataset.columns` i `dataset.rows`, jer generator ugovora odbija objekt koji sadrži nizove.
