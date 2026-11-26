# scripts/owner-board

Vlasnička ploča (DAN-1569): jedna samostalna HTML stranica s onim što čeka vlasnika. Samo čita; u GitHubu i Linearu ne mijenja ništa.

```bash
GITHUB_TOKEN=... LINEAR_API_KEY=... pnpm owner:board --state <put do STATE.md> \
  --repo ductura/institution_server --repo ductura/institution_front_web_chrome \
  [--out owner-board.html] [--stale-days 3]
```

## Što prikazuje

| Dio                 | Izvor                              | Što                                                                                                   |
| ------------------- | ---------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Owner queue po roku | `STATE.md`, odjeljak „Owner queue” | Otvorene stavke po najranijem roku; prekoračeni rok je istaknut, stavke bez roka su na kraju.         |
| Otvoreni PR-ovi     | GitHub, samo `GET`                 | Rizik iz opisa, review i QA verdikt za trenutačni head, stanje CI-ja i čeka li PR vlasnikovu naredbu. |
| Zadaci u radu       | Linear, jedan upit                 | Zadaci u stanju vrste „started” kojima je početak stariji od `--stale-days` dana.                     |

Svaki dio navodi svoj izvor i trenutak čitanja. Ploča je pregled: status vrijedi u svom izvoru, ne ovdje.

## Datoteke

- `queue.ts`: red čekanja iz teksta `STATE.md`.
- `pulls.ts`: čitanje PR-ova i što PR kaže o vlastitom gateu.
- `render.ts`: stranica kao tekst.
- `cli.ts`: argumenti, čitanje izvora i pisanje datoteke.
- `owner-board.test.ts`: testovi nad izmišljenim podacima.

## Poznate granice

- **„Čeka vlasnika” je izvedeno ovdje**, ne pročitano iz gatea: rizik `critical`, nije nacrt, review i QA `PASS` na trenutačnom headu i CI prošao. Ne zna za Owner Override ni za iznimku čistog spajanja osnovne grane (D-101). Odlučuje gate.
- **Rok se čita samo u obliku `Rok: D. M. GGGG.`** Rok napisan drukčije („do 13. 11.”) ne vidi se i stavka ide među one bez roka.
- **Najviše 100 otvorenih PR-ova po repou i 100 komentara po PR-u**; ostalo se ne čita.
- **Prag od tri dana za zadatke u radu je moj prijedlog**, nije dogovoren; mijenja se s `--stale-days`.
- Dio koji se ne može pročitati (nema tokena, izvor ne odgovara) piše „Nije učitano” s razlogom, nikad kao prazan popis. Poruka greške i tokeni ne ulaze u stranicu.
- Čitanje GitHuba provjereno je uživo na repou Ductus; čitanje Lineara samo testom nad izmišljenim odgovorom.
- Odluka vlasnika 25. 11. 2026. („ti odluči”): alat živi ovdje, jer je stari repo zamrznut, a `scripts/orchestrator/` je `critical`.
