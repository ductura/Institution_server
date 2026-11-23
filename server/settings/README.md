# server/settings

Područje iz [karte servera](../../docs/server-map.md). Rute, sheme i servis su za sada prazni (S-1A-a); logika je interval sakupljača metrika (S-1K.4-b, DAN-834-4b).

## Što radi

Postavke iz okoline i njihova provjera pri pokretanju. Odbija lažni OIDC i razvojni potpisnik izvan lokalnog rada i CI-ja (D-09).

`metrics-interval.ts` (DAN-834-4b): interval sakupljača metrika (`createMetricsCollector`, `server/metrics`) iz varijable `METRICS_INTERVAL_MS`, u milisekundama, neobavezan, cijeli broj od 5000 do 3600000 napisan samo znamenkama, zadano 60000. Donja granica ostavlja mjesta jednom krugu (provjera baza 2 s i upis uzorka 1 s), gornja je jedan sat. `metricsIntervalProblems(env)` vraća problem samo imenom varijable, nikad vrijednošću; `metricsIntervalMs(env)` se zove tek kad problema nema. Čita se samo vlastito podatkovno svojstvo okoline: naslijeđeni ključ je kao da varijable nema, a getter i vrijednost koja nije niz su problem (getter se ne poziva). `server/server.ts` dodaje problem u provjeru okoline pri pokretanju, pa neispravna vrijednost zaustavlja pokretanje prije slušanja, a interval predaje sakupljaču (DAN-834-5a).

`institutions.ts` (DAN-911-1, S-M-2): provjera popisa ustanova prema shemi Ductusa `src/domain/institution-config/registry.ts` na `b36c82b`. Podaci su Ductusov `config/institutions.json` prenesen kao `institutions-file.ts` (isti sadržaj; `.ts` jer svaki relativni uvoz imenuje `.ts`, a gradnja ga ugrađuje u `dist/server.js`). Korijen točno `{format, institutions}`, format `ductus-institutions-v1`, svaki zapis točno `{slug, citationStyle}` po vlastitim ključevima, `slug` prema CHECK-u `identity.institution.slug`, bez duplikata, `citationStyle` iz zatvorenog skupa (`fpzg`; stilovi citiranja ne dolaze na server, pa se provjerava samo ime). `loadInstitutions(input)` vraća `Result` sa zamrznutim zapisima ili prvu grešku redom Ductusa, u obliku `{ code, messageKey }` (CODE_STYLE §8; kodovi `INSTITUTIONS_ERROR_CODES`, tekstovi u `locales/hr.json` pod `institutions`); `institutionsProblems()` daje kod greške kao popis za provjeru pri pokretanju. Greška nikad ne nosi vrijednost ulaza; getter se ne poziva. Poziv iz `server/server.ts` dolazi u DAN-911-2.

`test-mode.ts` (S-1H.7, DAN-938-1): `testModeProblems(env)` provjerava varijablu `DUCTURA_MODE`, prekidač testnog servera. Bez nje nema problema. Jedina poznata vrijednost je točno `test`, a dopuštena je samo uz `NODE_ENV` `development` ili `test`. U svakoj drugoj konfiguraciji, uključujući nepostavljen ili prazan `NODE_ENV`, problem je `DUCTURA_MODE test is refused in production`. Svaka druga vrijednost daje `DUCTURA_MODE is not a known mode`, bez obzira na `NODE_ENV`: prazna (i compose `${X:-}`), druga velika slova, razmak, CRLF, tab, NBSP, DEL, NUL, nevidljivi i slični znakovi. Tako tipfeler ne skriva provjeru i ne uključuje način rada. Čitaju se samo vlastita podatkovna svojstva (`DUCTURA_MODE` i `NODE_ENV`), a getter je problem i ne poziva se. `server/server.ts` dodaje problem u provjeru pri pokretanju, pa proces ne sluša i izlazi s 1. Što način rada uključuje (lažni OIDC, sintetički podaci) dolazi s DAN-938-3. Poznata granica: `ductura_mode` je na Linuxu druga varijabla i ne gleda se, pa se način rada time ne uključuje.

`deployment.ts` (STG-PRIJAVA, Ductus#2055): `deploymentProblems(env)` provjerava `DUCTURA_DEPLOYMENT`. Bez nje nema problema. Jedina poznata vrijednost je točno `staging`, i to samo uz `APP_ORIGIN` koji je goli https origin izvan produkcijske domene (`PRODUCTION_DOMAIN`, `ductura.org`; `isProductionHost` uključuje apex i svaku poddomenu, bez obzira na velika slova i završnu točku). Inače je problem `DUCTURA_DEPLOYMENT staging needs an https APP_ORIGIN outside the production domain`, a svaka druga vrijednost daje `DUCTURA_DEPLOYMENT is not a known deployment`; `server/server.ts` tada ne sluša. `stagingDeploymentOrigin(env)` i `isStagingDeployment(env)` daju staging origin samo u tom jednom slučaju: `external/srce-auth` po njemu prihvaća lažnog pružatelja u produkcijskoj gradnji, a ulazna točka uključuje oznaku `X-Ductura-Deployment: staging` na svakom odgovoru i upozorenje `server.staging` pri pokretanju. Čitaju se samo vlastita podatkovna svojstva, getter se ne poziva.

`non-production.ts` (DAN-938-1): `isNonProductionBuild(nodeEnv)` je jedina definicija produkcije: popis dopuštenih, samo `development` i `test`. Premještena je bez promjene iz `server/external/srce-auth/config.ts`, koji je i dalje izvozi pod istim imenom za provjeru lažnog pružatelja (D-09). Ulazna točka i `server/config` ne smiju uvoziti `external/srce-auth`.

## Tko ga zove

`log`, `metrics`, `database`, `external/srce-auth`, `external/storage`, `external/keys`, `external/email`, `traffic`, `session`, `roles`, `legal`, `backup`, `deletion`, `downloads`, `profile`, `support`, `http` i `test-server`.

## Koje podatke dira

Varijable okoline i popis ustanova (`institutions-file.ts`, bez tajni: ključevi potpisa i domene pohrane nisu u njemu). Tajne nikad nisu u repou.

## Što izvozi

- `SETTINGS_ROUTES`: popis ruta, za sada prazan (`routes.ts`);
- `SETTINGS_SCHEMAS`: sheme, za sada prazne (`schemas.ts`);
- `SettingsService`: tip servisa bez članova (`service.ts`);
- `metricsIntervalProblems`, `metricsIntervalMs`, `DEFAULT_METRICS_INTERVAL_MS`, `METRICS_INTERVAL_MIN_MS` i `METRICS_INTERVAL_MAX_MS` (`metrics-interval.ts`);
- `institutionsProblems`, `loadInstitutions`, `INSTITUTIONS_ERROR_CODES` i tipovi `InstitutionRecord`, `InstitutionsErrorCode`, `InstitutionsResult` (`institutions.ts`);
- `testModeProblems` (`test-mode.ts`) i `isNonProductionBuild` (`non-production.ts`);
- `deploymentProblems`, `stagingDeploymentOrigin`, `isStagingDeployment`, `isProductionHost`, `DEPLOYMENT_VARIABLE` i `PRODUCTION_DOMAIN` (`deployment.ts`).

## Što ne smije uvoziti

Ne uvozi ništa iz drugih područja. Popis je u [karti servera, §2](../../docs/server-map.md#2-dopušteni-uvozi); provjeru u CI-ju uvodi S-1A-b.
