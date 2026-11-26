# B0.2: mjerenje rekonstrukcije na poslužitelju

F4-PM2-R22, M3.4 (DAN-388). Mjeri rekonstrukciju rada od 15.000 riječi (pilot) i 80.000 riječi (doktorski, izvan pilota) kodom poslužitelja iz `server/evidence/reconstruction`: puni replay, izgradnju kontrolnih točaka i čitanje nastavljeno od zadnje točke. Zapis je izmišljen (jedan odlomak koji raste po 20 izmišljenih riječi po odsječku); nema baze, mreže ni pravih radova.

```sh
node --test spikes/b0.2-reconstruction/measure.test.ts
node spikes/b0.2-reconstruction/run.ts <oznaka-stroja> --out spikes/b0.2-reconstruction/results/<oznaka-stroja>.json
```

## Što ovo NIJE

**Ovo nije mjerenje na stroju koji se kupuje.** M3.4 ovisi o B0.1 (D-08, računi dobavljača; radnja vlasnika) i stvarnom stroju. Brojke ispod su sa strojem iz oblaka (4 vCPU, 16 GB, Node v24) i samo su osnovica. Kad B0.1 dovrši stroj, isti se alat ponovno pokreće na njemu (`<oznaka-stroja>` = naziv tipa VM-a) i M3.4 se tek tada zatvara.

Dodatna ograničenja:

- Replayer iz `record.fixture.ts` samo dodaje tekst u jedan odlomak. Stvarni ProseMirror/Tiptap replay s više čvorova i oznaka izmjeren je u Ductusu (`spikes/b0.2-reconstruction`, `docs/spikes/B0.2.md`) i skuplji je po koraku; ovdje se mjeri tek trošak lanca, hashiranja i kanonskog oblika na poslužitelju.
- Vršak heapa uključuje sam izgrađeni zapis i smeće koje GC nije pokupio, pa je gornja procjena, ne trajna potrošnja.
- Jedan prolaz po scenariju, bez zagrijavanja; vrijeme je orijentacijsko.

## Rezultati osnovice (oblak, 4 vCPU)

`results/oblak-sesija-bez-stroja.json`.

| Riječi | Odsječaka | Točka svakih | Puni replay | Čitanje od zadnje točke | Točaka / volumen | Vršak heapa |
| -----: | --------: | -----------: | ----------: | ----------------------: | ---------------: | ----------: |
| 15.000 |       750 |           50 |      356 ms |        53 ms (50 odsj.) |     15 / 1,1 MiB |     233 MiB |
| 15.000 |       750 |          200 |      312 ms |      115 ms (150 odsj.) |      3 / 0,2 MiB |     272 MiB |
| 80.000 |     4.000 |           50 |   10.111 ms |       259 ms (50 odsj.) |    80 / 33,2 MiB |   3.367 MiB |
| 80.000 |     4.000 |          200 |   12.411 ms |    1.032 ms (200 odsj.) |     20 / 8,6 MiB |   4.628 MiB |

## Zaključci (za provjeru na pravom stroju)

- 15.000 riječi: puni replay oko 0,3 s, daleko ispod 2 s granice Edge Functions iz `docs/backend/pregled.md`; argument CPU-a protiv takvih dobavljača za pilot ne stoji.
- 80.000 riječi: puni replay raste kvadratno (svaki odsječak nosi cijeli dokument), oko 10 do 12 s i nekoliko GiB heapa. Za doktorske radove kontrolne točke nisu optimizacija, nego uvjet: čitanje od točke svakih 50 odsječaka je oko 0,26 s.
- Cijena točaka je volumen (33 MiB uz 80.000 riječi i razmak 50, 8,6 MiB uz 200). Razmak se bira uz B0.3; ovdje se ne odlučuje.

## Otvoreno

- Ponavljanje na stroju iz B0.1 (radnja vlasnika; zatvara M3.4).
- Mjerenje s pravim editor replayerom na SRV-u, ako ga zadatak kasnije traži.
