# infra/web

Slika web procesa servera (DAN-893). Gradi se iz korijena repozitorija: `docker build -f infra/web/Dockerfile .`. Deploy, registry i kontejner workera (DAN-894) nisu ovdje.

- `Dockerfile`: dvije faze. `build` instalira ovisnosti (`pnpm install --frozen-lockfile --ignore-scripts`) i `pnpm build` pakira server u `dist/server.js` ([scripts/build](../../scripts/build/README.md)). Završna faza dobiva samo tu datoteku, radi kao korisnik `node`, ima `HEALTHCHECK` na rutu zdravlja `GET /api/v1/health` i pokreće `node` s `SERVER_NODE_FLAGS`. Obje faze imaju istu baznu sliku prikvačenu digestom (`mirror.gcr.io`, kao `compose.yaml`), s glavnom verzijom Nodea iz `.nvmrc`.
- `Dockerfile.dockerignore`: `.git`, `node_modules`, `dist`, `.stack`, `coverage` i svaki `.env` ne ulaze u kontekst izgradnje.
- `dockerfile.test.ts`: pravila Dockerfilea na stvarnoj datoteci i na izmjenama koje moraju pasti, te korak CI-ja.

Konfiguracija dolazi samo iz okoline kod `docker run` (`APP_DATABASE_URL` i ostalo iz `server/config`). U slici su samo `HOST=0.0.0.0`, jer je zadani host loopback i kontejner izvana ne bi bio dostupan, i `PORT=4000`. `NODE_ENV` se ne postavlja, a neodređen znači produkcija. Ruta zdravlja daje 200 i kad je stanje `degraded`, pa `healthy` znači da proces odgovara, ne da je baza spremna.

CI (posao `checks`, korak „Slika web procesa (DAN-893)”) gradi sliku i provjerava da je u `/app` samo `dist/server.js`, da `id -u` nije 0 i da su u okolini slike samo dopuštena imena. Zatim pokreće kontejner s izmišljenim URL-om baze, čeka stanje `healthy`, dohvaća rutu zdravlja i provjerava da `docker stop` završi s kodom 0.
