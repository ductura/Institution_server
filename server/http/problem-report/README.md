# Prijava problema

`POST /api/v1/problem-reports` prima kategoriju, opis i verziju aplikacije te vraća referencu prijave. Sesija određuje korisnika i ustanovu. Obje rute koriste isti RPC i dijele ograničenje od pet prijava po računu u kliznom satu. Prihvaćene prijave vidi njihov autor kroz RLS. Bazna uloga `ductus_problem_report_reader` operateru omogućuje čitanje svih prijava, a dodjeljuje se pri konfiguraciji operaterskog pristupa.
