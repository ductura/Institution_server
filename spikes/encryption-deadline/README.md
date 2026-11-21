# Šifriranje rada do roka

SRV-1507, M3.12. Spike na izmišljenim radovima ispituje šifriranje sadržaja ključem po radu i otključavanje po isteku roka. D-122 i D-207 odnose se i na lokalni zapis u pregledniku. Ovdje je izmjeren samo model u Nodeu. [Plan migracije](../../docs/plan/PLAN-MIGRACIJE.md) · [D-122](https://github.com/danielrisavi77-create/Ductus/issues/87#issuecomment-6233852560) · [D-207](https://github.com/danielrisavi77-create/Ductus/issues/87#issuecomment-6567392018)

## Što spike simulira

Za svaki zapečaćeni rad generira se svježi 256-bitni ključ. AES-256-GCM šifrira sadržaj tim ključem i zasebno omata ključ rada prolaznim ključem iz memorije procesa. Identitet rada i rok autentificirani su u oba zapisa. Kontrolirani sat dopušta otvaranje kad je `sada ≥ rok`, u milisekundama od Unix epohe. Rok i identitet dio su zapečaćenog zapisa pa ih izmjena zapisa čini nevaljanim za otvaranje.

Sve se izvršava u procesu CLI-ja, s izmišljenim sadržajem i identifikatorima. Završetkom procesa gubi se ključ za otvaranje. Spike nema mrežu, pravi KMS, trajnu pohranu, korisničke uloge ni veze s aplikacijom.

```sh
node --test spikes/encryption-deadline/deadline-encryption.test.ts
node spikes/encryption-deadline/benchmark.ts
```

Prošlo je 11 provjera. Pokrivaju granicu roka u tri točke, nevaljane vrijednosti vremena, krivi ključ procesa, izmjene roka, identiteta i šifrata te zamjenu ključa ili sadržaja između zapisa.

## Izmjereni trošak

Windows 10 (19045) x64, AMD Ryzen 5 1600, Node v26.13.1 i OpenSSL 3.5.9. Izvedena su tri odvojena pokretanja. U svakome je po veličini bilo 30 zagrijavanja i 300 uzastopnih mjerenja. Rasponi u tablici obuhvaćaju rezultate triju pokretanja. Šifriranje uključuje izradu i omatanje ključa, a otvaranje provjeru roka, odmotavanje ključa i dešifriranje. Nakon svakog mjerenja skripta provjerava jednakost s izvornim sadržajem.

| Sadržaj | Šifriranje p50 / p95 (ms) | Otvaranje p50 / p95 (ms)  | Dodatak (B) |
| ------: | ------------------------- | ------------------------- | ----------: |
|  16 KiB | 0,048–0,052 / 0,092–0,116 | 0,036–0,038 / 0,075–0,086 |          88 |
| 256 KiB | 0,292–0,304 / 0,601–0,665 | 0,274–0,284 / 0,480–0,498 |          88 |
|   1 MiB | 1,171–1,190 / 1,528–1,616 | 1,102–1,122 / 1,436–1,498 |          88 |

Izmjerenih 88 B čine omotani ključ od 32 B, dva noncea od 12 B i dvije autentifikacijske oznake od 16 B. Identifikator, rok, serijalizacija i metapodaci pohrane nisu uračunati. Latencije vrijede za sekvencijalnu obradu u memoriji. Trošak mreže, pravog KMS-a, IndexedDB-a i istodobnih otvaranja nije izmjeren.

## Preporuka za M3.12

Zadržati šifriranje s ključem po radu kao kandidat za verziju rada koja se otvara nakon roka. Za pilot prvo izmjeriti cijeli put s odvojenom kontrolom pristupa ključu, pouzdanim poslužiteljskim vremenom i vršnim opterećenjem na roku. Za D-122 zasebno ispitati šifriranje lokalnog zapisa u IndexedDB-u i rok njegova čuvanja, uz odjavu, rad bez mreže i oporavak nakon ponovnog pokretanja preglednika.

## Rizici i odluke vlasnika

- **Pristup prije roka.** Tko mora čitati rad prije roka (student pri uređivanju, mentor uz dopuštenje) i tko smije otvoriti zapečaćenu verziju nakon roka? Otključavanje po vremenu treba biti uvjet uz redovnu provjeru pristupa. Kompromitiran proces s ključem može zaobići simulirano pravilo vremena.
- **Produženja i dostupnost.** Tko odobrava promjenu roka i koja verzija roka vrijedi za već zapečaćeni rad? Što prikazati kada izvor vremena ili servis ključeva privremeno nije dostupan? Treba odrediti pravila oporavka, rotacije ključeva i pristupa sigurnosnim kopijama.
- **Lokalni zapis.** Koliko dugo rad mora ostati dostupan bez mreže i što se s lokalnim kopijama događa nakon odjave ili isteka roka čuvanja? Ključ dostupan istom pregledniku za rad bez mreže ostaje dostupan i kompromitiranom kontekstu tog preglednika. Zapečaćena kopija ne štiti izvorni sadržaj u editoru, predmemorijama ili izvozu.
