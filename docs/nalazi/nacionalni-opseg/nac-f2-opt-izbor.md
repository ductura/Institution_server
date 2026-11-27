# NAC-F2-OPT: izbor jedne optimizacije

Odluka Daniela (27. 11. 2026.): jedan mali ciklus, izmjeri, smanji najveći dokazani trošak, istim testom potvrdi. Ovaj dokument je prvi korak: izbor i obrazloženje, bez promjene koda. Izvor mjerenja je [sat-pisanja.md](sat-pisanja.md), ponovljeno na bazi `54d3fd78ce5a` naredbom `node scripts/load/nac/sat-pisanja-proba.ts` (isti brojevi: 2017 zahtjeva, 40,7 MB, 274 potpisa).

## Troškovi iz mjerenja, po tablici naloga

| Vrsta troška iz naloga                            | Dokaz u mjerenju                                                                                                                         | Veličina                                                                           |
| ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| Dupli zahtjev                                     | Nije pronađen: spremanja i objave su različiti zahtjevi; 26 ponovljenih pokušaja je tijekom prekida veze i očekivani su                  | 26 od 2017 zahtjeva, bez prometa koji bi se mogao ukloniti                         |
| Isti skupi izračun više puta                      | Nije izmjeren: vrijeme obrade, upiti i CPU traže lokalni stog (sat-pisanja.md, „Što nije izmjereno”)                                     | nema dokaza                                                                        |
| Provjere potvrda (tempiranje, objedinjavanje)     | Nije izmjereno: vrijeme do provjerene potvrde traži lokalni stog                                                                         | nema dokaza                                                                        |
| Spori upit                                        | Nije izmjeren: `pg_stat_statements` traži lokalni stog                                                                                   | nema dokaza                                                                        |
| **Cijeli dokument pri svakom spremanju i objavi** | Izmjereno: tijelo spremanja je cijela snimka (1 992 B do 165 470 B), objava uživo šalje cijelu snimku, a čitanje 200 vraća cijelu snimku | 32 470 680 B poslano + 10 251 406 B primljeno = **sav izmjereni promet (40,7 MB)** |

Zaključak: najveći (i jedini) dokazani trošak je ponavljanje cijele snimke dokumenta. Čitanja 304 čine 67 % zahtjeva (1345 od 2017), ali nose zanemariv broj bajtova i dolaze iz ritma klijenta od 1 s, a ne s poslužitelja.

## Izbor

Redak tablice: **cijeli dokument pri svakoj objavi → NAC-SPEC-UZIVO/DELTA**.

To traži promjenu oblika zahtjeva (`evidence.commit.post` nosi `document`; `live.document.put` nosi JCS bajtove snimke). Nalog izričito kaže: oblik zahtjeva spremanja evidencije se ne mijenja, nema promjene ugovora, a ovaj redak traži Danielovo „da”. **Zato ovdje stajem: drugi PR (izmjena) se ne otvara dok Daniel ne odluči.**

## Što nije izabrano i zašto

- Dupli zahtjev, isti skupi izračun, provjere potvrda, spori upit: nema dokaza u izmjerenom, a mjerenje se bez lokalnog stoga ne može dopuniti. Optimizacija bez dokaza bi kršila nalog („najveći dokazani trošak”).
- Skraćivanje čitanja 304 ili ponovnih pokušaja: mijenja ritam klijenta u WEB repou, a ne ovdje, i ne smanjuje promet.

## Odluka koja je potrebna od Daniela

Smije li se otvoriti zadatak NAC-SPEC-UZIVO/DELTA (slanje razlike umjesto cijele snimke za objavu uživo, odnosno spremanje)? Promjena je promjena ugovora (major ili aditivna nova ruta) pa nije dio ovog zadatka. Ako je odgovor „da”, mjerilo ostaje isto: isti scenarij i stroj prije i poslije, bez obećanog postotka. Ako je odgovor „ne” ili „kasnije”, ciklus se zatvara ovim dokumentom, a sljedeće izmjerivo je potrebno dobiti na lokalnom stogu (Graditelj: 1 pa 100 korisnika), da bi ostali retci tablice dobili dokaz.
