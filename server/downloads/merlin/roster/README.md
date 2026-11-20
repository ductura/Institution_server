# server/downloads/merlin/roster

Popis za Merlin (SRV-1109, Val 11, N-18, C-16, D-286) u području [preuzimanja](../../README.md).

## Što radi

Sastavlja popis jednog zadatka: redak po studentu, poredak po prezimenu (hrvatska abeceda, `compareHr`), pa imenu, pa oznaci studenta; student bez para imena je zadnji. Stupci su iz D-286: prezime, ime, predano, vrijeme predaje (na minutu), nakon roka (prema roku koji je vrijedio uz odobreno produljenje, kako ga je predaja zabilježila) te nazivi datoteka u paketu (PDF i DOCX) s otiscima SHA-256. Student bez predaje ima prazne nazive i otiske. Ništa iz sažetka procesa, nijedan razlog i nijedan privatni kriterij nije stupac.

`merlinRosterCsv` daje iste retke i stupce kao CSV (RFC 4180, CRLF, UTF-8 s oznakom redoslijeda bajtova; ćelija koja bi se čitala kao formula dobiva apostrof). `createMerlinRosterReader` spaja tri čitanja pod sesijom pozivatelja: produljenja roka (SRV-1108, ujedno provjera pristupa: samo nastavnik zadatka, inače `not_found`), predaje i dokumente predane revizije (`../files`). Ako se predaja i dokument ne slažu u studentu ili reviziji, čitanje baca, a ruta odgovara 503, nikad popis s datotekom koja nije predana. Razlozi produljenja izlaze samo kroz projekciju N-13 i C-16 (razlog, student ili svi, novi rok), i to samo na zapisima koje je pozivatelj sam upisao.

## Tko ga zove

`server/http/merlin-roster`.

## Koje podatke dira

Samo ulaz funkcija i portove koje mu preda adapter. Ne otvara bazu ni pohranu sam.

## Što izvozi

`buildMerlinRoster`, `merlinRosterCsv`, `createMerlinRosterReader`, natpise (`MERLIN_CSV_HEADER`, `MERLIN_CSV_YES`, `MERLIN_CSV_NO`, `MERLIN_EXPORT_LABELS`) i tipove iz `index.ts`.

## Što ne smije uvoziti

Vrijede rubovi iz [karte servera](../../../../docs/server-map.md): `domain`, `database` samo s `import type`.

## Otvorene stavke

Natpisi su u `labels.ts`, a ne u katalogu `locales/` (popis datoteka i broj tekstova kataloga drži `scripts/forbidden-terms`); `labels.test.ts` ih provjerava istim rječnikom zabranjenih izraza.
