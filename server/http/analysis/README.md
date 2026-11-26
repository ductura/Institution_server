# HTTP za statističku analizu (val 15)

`GET /api/v1/analysis/catalogue` i `POST /api/v1/analysis/runs` (SRV-V15-HTTP): tanki adapter nad čistom domenom `server/domain/analysis` (`runAnalysis`). Račun je u zahtjevu: bez tablice, bez pohranjenog izračuna, bez zapisa sadržaja skupa ili rezultata u dnevnik. Jedini poziv baze je čitanje sesije (`app.my_account()`), pa stara sesija daje 401.

Zastavica `ANALYSIS_ENABLED` je `false` i mijenja se samo vlasnikovim PR-om. Dok je isključena, obje rute odgovaraju 404 `not_found` (prije provjere sesije), kao da ne postoje.

Redoslijed kad je uključena: čitanje s istog izvora (GET), sesija (401), vrsta sadržaja (415), ograničeno tijelo (413), JSON (400), oblik po ugovoru (422), izračun (422 `invalid_input` ili `unknown_analysis_version`). Katalog i ograničenja dolaze iz registra i domene; test provjerava da su jednaki ugovoru.
