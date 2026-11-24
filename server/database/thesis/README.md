# Obrasci fakulteta, suglasnost mentora i stanje nakon predaje

`createThesisStore` (SRV-MENTOR-2) čita i piše samo kroz RPC-e `app.*` iz migracije `20261216120000_thesis_forms_consent.sql`: popis obrazaca fakulteta s verzijom, postavku fakulteta (suglasnost mentora za predaju, zadano isključeno), stanje svakog obrasca na radu, suglasnost mentora s cijelom poviješću i stanje nakon predaje (predano referadi, zakazana obrana, obranjeno). Tko smije čitati i pisati odlučuje baza (student vlasnik, mentor rada, administrator fakulteta); ništa od ovoga ne ulazi u ocjenu.
