# Tema završnog ili diplomskog rada: prijedlog studenta i odluka mentora

`createThesisTopicStore` (SRV-V16-TEMA-PRIJEDLOG) čita i piše samo kroz RPC-e `app.*` iz migracije `20261220110000_thesis_topic.sql`: stanje teme rada, zadnji prijedlog, odluku na njemu i sve verzije prijedloga. Tko smije što odlučuje baza: čitaju student vlasnik, mentor i administrator fakulteta, predlaže samo student, odlučuje samo mentor. Zapis je samo za dodavanje; ništa od ovoga ne ulazi u ocjenu i ne mijenja obrazac `prijava-teme`.
