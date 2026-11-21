# PDF/A-2u preko LibreOfficea

SRV-1805, M8.5-S, spike S-PDF. Ispituje smjer iz D-254: kanonski dokument → DOCX → PDF/A-2u preko LibreOfficea u izoliranom kontejneru bez mreže, uz OFL fontove i sliku pinanu digestom. Valjanost provjerava veraPDF s fiksnim profilom `-f 2u` (D-206). Sav tekst je izmišljen. [Plan migracije](../../docs/plan/PLAN-MIGRACIJE.md) · [D-206](https://github.com/danielrisavi77-create/Ductus/issues/87#issuecomment-6564175279) · [D-253 i D-254](https://github.com/danielrisavi77-create/Ductus/issues/87#issuecomment-6587383297) · [D-284](https://github.com/danielrisavi77-create/Ductus/issues/87#issuecomment-6744921680)

## Ishod

**Spike je prošao.** Dokument od 15.000 riječi postaje PDF/A-2u koji veraPDF 1.30.4 prihvaća (`isCompliant="true"`, 146 pravila, 0 palih). Pretvorba traje oko 1 s CPU-a, a vršna memorija kontejnera je oko 105 MiB. Varijanta pdfkit zato ne ide vlasniku.

Jedan nalaz mijenja put iz D-254. LibreOffice nudi samo PDF/A-1b, 2b i 3b, pa ne zna izvesti razinu U. Njegov PDF/A-2b na profilu `-f 2u` pada samo na pravilu 6.6.4 t3, a to je oznaka razine u XMP metapodacima (`pdfaid:conformance` je `B`). Sve tehničke provjere razine U prolaze, uključujući preslikavanje svog teksta u Unicode (6.2.11.7). Spike zato mijenja to jedno slovo iz `B` u `U` (`declarePdfA2u`). Duljina datoteke ostaje ista, pa pomaci u tablici xref vrijede. Nakon toga veraPDF prihvaća datoteku. Izmjena ništa ne dokazuje sama: oznaka „PDF/A” smije se pokazati samo uz `isCompliant="true"` (D-284). Bez toga ide obični PDF s rečenicom „Ova datoteka nije u obliku PDF/A” i DOCX.

## Postav

| Dio         | Vrijednost                                                                                                                                                                  |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| LibreOffice | `gotenberg/gotenberg@sha256:53073e798c8ef39ea2187e44cb67bab77894ea2509100b94c4fe3b461f7b2996` (Gotenberg 8.40.0, LibreOffice 26.8.2.2, Debian 13.7, 2,42 GB, `linux/amd64`) |
| veraPDF     | `verapdf/cli@sha256:c2ac9448973a56acd833c81441e38d2dca58ea26a2ce1621e9a32e85d3d2728f` (veraPDF 1.30.4, 137 MB); nije u `package.json` (D-253)                               |
| Font        | Liberation Serif 2.1.5 (`fonts-liberation`, SIL OFL 1.1) iz iste slike; dokument traži samo njega                                                                           |
| Filtar      | `pdf:writer_pdf_Export:{"SelectPdfVersion":{"type":"long","value":"2"}}` (PDF/A-2b)                                                                                         |

Obje slike pinane su digestom indeksa (`images.ts`). Oznaka verzije služi samo čitatelju jer Docker razrješava digest. Kontejner se pokreće s `--pull=never`, pa ne radi sa slikom koja lokalno nije pod tim digestom.

Svaka pretvorba je zaseban `docker run` (`isolatedRunArgs` u `convert.ts`):

- `--network=none`: kontejner ima samo sučelje `lo`;
- nema montiranja s domaćina: DOCX ulazi kroz stdin, PDF izlazi kroz stdout;
- `--read-only` korijen i `tmpfs` od 512 MiB za `/tmp` (profil LibreOfficea i radne datoteke);
- `--cap-drop=ALL`, `--security-opt=no-new-privileges`, korisnik 1001 (ne root);
- ograničenja `--cpus=1`, `--memory=1024m` bez swapa i `--pids-limit=256`.

veraPDF radi u istom obliku izolacije, bez mreže i s PDF-om na stdinu.

## Dokument

`corpus.ts` gradi izmišljeni seminarski rad o kućnom kompostiranju u izmišljenom gradu Lipovcu, s točno 15.000 riječi (naslov, autor, naslovi i odlomci). Tekst sadrži hrvatske dijakritike i navodnike „”. Generator je determinističan. `docx.ts` piše DOCX bez nove ovisnosti. Dokument ima stilove, poravnate odlomke s proredom 1,5, naslove dviju razina, 23 bilješke na dnu stranice, tablicu s obrubom, izdvojeni citat, podnožje s brojem stranice (polje `PAGE`) i jezik `hr-HR`. Rezultat je PDF od 41 stranice (324 kB). U njemu su ugrađeni samo podskupovi fontova Liberation Serif, Bold i Italic. Neugrađenih fontova nema.

## Mjerenja

Linux 6.18 x64, Intel Xeon 2,10 GHz (4 jezgre), 16 GiB, Docker 29.10 (cgroup v1), Node v24.22.3; 21. 11. 2026. Svaki redak je jedno zagrijavanje i 5 mjerenja. Svaki izlaz prošao je veraPDF `-f 2u` s `isCompliant="true"`. „docker run” je cijeli poziv sa startom kontejnera. „soffice” je vrijeme same pretvorbe, izmjereno u kontejneru. CPU i vršnu memoriju kontejner čita iz vlastitog cgroupa (`cpuacct.usage`, `memory.max_usage_in_bytes`; na cgroup v2 `cpu.stat` i `memory.peak`). Vršna memorija uključuje stranice u `tmpfs`-u jer ih ograničenje memorije broji.

| Riječi | Ograničenja     | docker run ms (medijan / najviše) | soffice ms  | CPU ms      | Vršna memorija MiB |
| -----: | --------------- | --------------------------------- | ----------- | ----------- | ------------------ |
| 15.000 | 1 CPU, 1024 MiB | 1229 / 1298                       | 943 / 1045  | 993 / 1104  | 105,4 / 105,6      |
| 15.000 | 2 CPU, 1024 MiB | 1103 / 1212                       | 850 / 953   | 911 / 1007  | 105,4 / 105,4      |
| 15.000 | 1 CPU, 256 MiB  | 1075 / 1163                       | 840 / 917   | 893 / 944   | 105,5 / 105,8      |
| 60.000 | 1 CPU, 1024 MiB | 1898 / 1937                       | 1639 / 1667 | 1662 / 1712 | 114,9 / 115,2      |

Istodobne pretvorbe od 15.000 riječi, kao pri roku predaje, svaka s 1 CPU-om i 1024 MiB:

| Istodobno | Sve gotove za | Vršna memorija po kontejneru | Zbroj vršnih memorija |
| --------: | ------------- | ---------------------------- | --------------------- |
|         4 | 1308 ms       | 105,6 MiB                    | 421,0 MiB             |
|         8 | 2334 ms       | 105,2 MiB                    | 840,2 MiB             |

Druga jezgra gotovo ništa ne donosi jer LibreOffice slaže dokument u jednoj niti. Ograničenje od 256 MiB ostavlja oko 2,4 puta više memorije od izmjerene vršne. Četiri puta dulji dokument traži oko 1,7 puta više CPU-a i 10 MiB više memorije. veraPDF za jedan dokument od 15.000 riječi treba 7 do 8 s s pokretanjem JVM-a. To je trošak CI-ja (M8.14), ne izvoza.

Nije izmjereno: slike u dokumentu, DOCX iz pravog pisca M8.4 (biblioteka `docx`), hladni start nakon prvog povlačenja slike od 2,42 GB, `linux/arm64`, cgroup v2 na stvarnom poslužitelju i dugotrajni servis Gotenberg preko HTTP-a. Spike mjeri jednokratni kontejner po pretvorbi, a start kontejnera dodaje oko 300 ms.

## Provjere

```sh
docker pull gotenberg/gotenberg@sha256:53073e798c8ef39ea2187e44cb67bab77894ea2509100b94c4fe3b461f7b2996
docker pull verapdf/cli@sha256:c2ac9448973a56acd833c81441e38d2dca58ea26a2ce1621e9a32e85d3d2728f
node --test spikes/pdf-a/pdf-a.test.ts
node --test spikes/pdf-a/pdf-a.integration.test.ts
node spikes/pdf-a/run.ts --runs 5 [--cpus 1] [--memory 1024] [--words 15000] [--parallel 4]
```

`pdf-a.test.ts` ne treba Docker. Provjerava da je tekst izmišljen, determinističan i da ima točno 15.000 riječi. Provjerava i da je DOCX ispravan paket koji traži samo OFL font. Za kontejner provjerava da ima `--network=none`, da nema montiranja ni dodanih ovlasti i da su obje slike pinane digestom. Uz to provjerava da se mijenja samo slovo razine, da odluku donosi izvješće veraPDF-a i kako se čitaju mjerenja.

`pdf-a.integration.test.ts` treba Docker i obje slike. Bez njih pada, ne preskače se. Provjerava:

1. da su obje slike lokalno pod pinanim digestom;
2. da kontejner pretvorbe ima samo `lo`, da TCP prema `1.1.1.1:443` ne prolazi, da DNS ne razrješava i da HTTPS ne prolazi; isti kontejner na mostnoj mreži pokazuje `eth0`, pa test razlikuje ta dva slučaja;
3. da 15.000 riječi daje PDF/A-2u koji veraPDF prihvaća, s ugrađenim samo Liberation Serifom;
4. da izvorni PDF/A-2b iz LibreOfficea na profilu 2u pada samo na 6.6.4 t3;
5. da obični PDF nije PDF/A i da ga `declarePdfA2u` odbija.

Testovi su izvan `pnpm test`, kao i [prethodni spike](../encryption-deadline/README.md). Vitest ne čita `spikes/`, a CI nema korak s Dockerom za ove slike.

## Preporuka za M8.5 i M8.14

- Zadržati smjer iz D-254: DOCX iz M8.4 → LibreOffice u kontejneru bez mreže → PDF/A-2b, oznaka razine U, zatim veraPDF `-f 2u`. Oznaka „PDF/A” samo uz `isCompliant="true"`, inače obični PDF i DOCX (D-284).
- U produkciji zadržati izolaciju iz spikea: kontejner bez mreže, bez montiranja i bez ovlasti, s ograničenjima. Za početak je dovoljno 1 CPU i 256 MiB po pretvorbi, uz red čekanja s ograničenim brojem istodobnih pretvorbi.
- Ako se odabere dugotrajni Gotenberg preko HTTP-a, mreža mora biti interna (`--internal`) i kontejner mora biti dostupan samo serveru. Spike to nije mjerio.
- Za M8.14 pin veraPDF-a preuzeti iz `images.ts`. Pretvorbu i provjeru valja ponoviti s pravim DOCX-om iz M8.4 i sa slikom u dokumentu.
- Slika Gotenberga nosi i Chromium te mnogo fontova (2,42 GB). Manja slika samo s LibreOfficeom i OFL fontovima smanjila bi površinu napada i hladni start, ali i nju treba pinati digestom.

## Rizici i otvorena pitanja

- **Oznaka razine.** Razinu U potvrđuje veraPDF, ne LibreOffice. Novija verzija LibreOfficea može promijeniti zapis XMP-a. Tada `declarePdfA2u` odbija datoteku, a izvoz pada na obični PDF; ne izdaje pogrešnu oznaku. Ako vlasnik ne prihvati izmjenu oznake, ostaje PDF/A-2b, ali to mijenja D-206 i traži njegovu odluku.
- **Fontovi.** Dokument smije tražiti samo fontove iz slike pod OFL-om. Znak kojeg nema u Liberation Serifu LibreOffice uzima iz drugog fonta u slici, a licenca tog fonta nije provjerena. Test zato dopušta samo Liberation Serif.
- **Traži li FPZG PDF/A** ostaje otvoreno (D-206 t. 4, Q-3).
