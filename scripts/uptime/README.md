# scripts/uptime

Periodična provjera dostupnosti izvana (DAN-1567, dio 3). Workflow `Provjera dostupnosti` (`.github/workflows/ready-probe.yml`) svakih 15 minuta jednom pogleda `/api/v1/ready`.

- Odgovor 200: ništa, ili zatvaranje otvorenog issuea uz jedan komentar.
- Bilo što drugo (drugi status, preusmjeravanje, nema veze, nema odgovora u 10 s): otvara se jedan issue „Poslužitelj ne odgovara na provjeru spremnosti”, a svaka sljedeća neuspjela provjera prepisuje njegovo tijelo (prvi pad, zadnja provjera, broj uzastopnih padova, zadnji ishod). Nema novog issuea ni komentara po provjeri.

## Uključivanje

Adresa je varijabla repozitorija `READY_URL` (Settings → Variables), u obliku `https://<domena>/api/v1/ready`. Dok varijabla nije postavljena, posao se ne pokreće. Tajne se ne koriste; token workflowa smije samo čitati repo i pisati issuee.

## Datoteke

- `probe.ts`: provjera adrese, jedan pogled i odluka što s issueom. Čisto, bez mreže osim predanog `fetch`.
- `cli.ts`: čitanje okoline, traženje otvorenog issuea (autor `github-actions[bot]` i točan naslov) i zapis.
- `uptime.test.ts`: testovi nad izmišljenim adresama, uključujući oblik workflowa.

## Poznate granice

- **Nije isprobano uživo**: još nema postavljene okoline ni varijable `READY_URL`. Provjereno je testovima i lažnim GitHubom.
- GitHub ne jamči točan raspored: zakazani workflow može kasniti ili izostati pod opterećenjem, a u repou bez aktivnosti 60 dana se gasi.
- Provjera ide s GitHubovih adresa; ako poslužitelj ograniči pristup po IP-u, treba ih propustiti.
- Od odgovora se čuva samo statusni kôd. Tijelo `/api/v1/ready` se ne čita.
- Pad same provjere (GitHub ne prima zapis) ruši posao s izlazom 1 i vidi se samo u Actions.
- Ne podiže alarm u `identity.ops_alarm`; signal je issue.
