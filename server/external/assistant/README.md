# server/external/assistant

Područje iz [karte servera](../../../docs/server-map.md).

## Što radi

Adapteri porta AI pomoćnika (`AssistantPort` iz [`server/domain/assistant`](../../domain/assistant/README.md); Ductus `docs/contracts/ai-request-v1.md`). Za sada postoji samo sintetički adapter `createSyntheticAssistant`: ne otvara mrežnu vezu i ne treba tajnu (S1, M9), a deterministično vraća svaku granu S2 iz skripte koju mu preda pozivatelj: uspjeh, grešku pružatelja (s prijavljenim troškom ili bez njega), istek, prekid nakon slanja, zakašnjeli odgovor (`deliverLate`) i trošak veći od rezervacije. Bilježi svaki ulaz porta (`calls`), da test pokaže što bi otišlo pružatelju (G8). Ulaz koji nije točno ulaz porta odbija kao programsku grešku. Stvarni adapter je OpenAI (`createOpenAiAssistant`, `openai-assistant.ts`, F4-PM2-R11, D-316): govori Responses API preko predanog transporta (sam ne otvara vezu i ne čita okolinu), a van javlja samo metapodatke (model, ishod, broj tokena, trajanje). Zahtjev šalje sa `store: false`, ali to ne znači da pružatelj ništa ne čuva: `store: false` samo ne sprema odgovor u stanje razgovora kod pružatelja, a OpenAI zahtjeve čuva u zapisima nadzora zloupotrebe do 30 dana, osim ako je računu odobreno nulto zadržavanje (ZDR). Je li to prihvatljivo, procjenjuje DPIA (`ductura/.github`, `docs/pravo/DPIA-OPENAI.md`) i DPO, ne ovaj kod; ZDR i ugovor nisu riješeni ovdje.

Bazna adresa pružatelja je iz zatvorenog popisa `OPENAI_BASE_URLS` (AI-EU-ADRESA): zadano je europski projekt `https://eu.api.openai.com/v1` (`OPENAI_BASE_URL`, kao u DPIA-OPENAI i EVIDENCIJA-OBRADA), a američka `https://api.openai.com/v1` vrijedi samo kad je varijabla okoline `OPENAI_BASE_URL` točno ta vrijednost. Svaka druga vrijednost (prazna, s razmakom ili kosom crtom na kraju, drugi host ili shema) zaustavlja pokretanje: `openAiBaseUrlProblems` u `server/server.ts` daje redak koji imenuje varijablu, nikad vrijednost, i proces izlazi s EX_CONFIG; nikad se tiho ne pada na SAD. Okolinu čita samo ulazna točka (`openAiBaseUrlOf(process.env)`), a adapter adresu izvan popisa odbija kao programsku grešku. Cijena iz broja tokena računa se iz stopa koje predaje sastavljač (zaokruženo prema gore). Sastavlja ga `server/http/assistant/openai-provider.ts` samo uz `OPENAI_API_KEY` i obje stope (`AI_RATE_INPUT_MICRO_PER_MTOK`, `AI_RATE_OUTPUT_MICRO_PER_MTOK`); model je `AI_MODEL` (zadano `gpt-6-luna`), verzija konfiguracije `AI_CONFIG_VERSION`. Bez ključa ili stopa port ostaje `ai_disabled`. Grane alata #1664.

Ispred adaptera je port pružatelja s vratima (`createAssistantProviderPort`, SRV-1809, M9.0-S2): vraća `ai_disabled` i ne zove adapter dok nisu ispunjena sva tri uvjeta, redom: postavka ustanove uključena, konfiguracija troška ima sve tri granice veće od nule (prazna ili djelomična znači isključeno, D-267 O5, P1) i adapter je sastavljen. Postavka ustanove (`readAssistantSetting`, M9.0-S3) ima tri zastavice (pomoćnik, transkripcija, alati pružatelja); svaka je uključena samo kad je točno `true`, a transkripcija i alati vrijede samo uz uključen pomoćnik. Produkcija je isključena (`PRODUCTION_ASSISTANT_SETTING`, `createProductionAssistantProviderPort`) i mijenja se samo vlasnikovim PR-om [OC-1]; popis odredišta pretrage je prazan [OC-2]. Nema pružatelja, iznosa ni modela računa (Q-10).

Testovi `no-external-ai.test.ts` i `no-cost-figures.test.ts` čuvaju da u repou nema poziva vanjskog AI-ja (SDK u ovisnostima ili lockfileu, uvoz, adresa API-ja pružatelja, mreža u kodu pomoćnika) ni brojki troška u kodu i migracijama pomoćnika. Adresu API-ja pružatelja smije imenovati samo `openai-assistant.ts`; `no-external-ai.test.ts` provjerava i zatvoreni popis adresa, zadano EU i da ulazna točka odbija nepoznatu vrijednost.

## Tko ga zove

`http`: ruta AI proxyja (`server/http/assistant`, SRV-1204, korak 4 ugovora) prima port i preko ovog sučelja čita ono što joj treba iz domene (parser zahtjeva, sastav uputa, ulaz porta, provjeru pružatelja), jer `http` ne smije uvoziti `domain`. Sintetički adapter stvaraju samo testovi; produkcijska kompozicija ima adapter samo uz ključ i stope iz okoline.

## Koje podatke dira

Ništa trajno. Ulaz porta postoji samo tijekom poziva i u popisu `calls` sintetičkog adaptera.

## Što izvozi

- `createAssistantProviderPort`, `createProductionAssistantProviderPort`, `isCostConfigured`, `AI_DISABLED_RULES`, `COST_LIMIT_KEYS`;
- `readAssistantSetting`, `institutionAiSwitchOf`, `ASSISTANT_SETTING_OFF`, `PRODUCTION_ASSISTANT_SETTING`;
- `createOpenAiAssistant`, `costOf`, `OPENAI_BASE_URL` (zadano EU), `OPENAI_BASE_URLS`, `OPENAI_EU_BASE_URL`, `OPENAI_US_BASE_URL`, `OPENAI_BASE_URL_VARIABLE`, `openAiBaseUrlOf`, `openAiBaseUrlProblems` i tipovi transporta, okoline i metapodataka;
- `createSyntheticAssistant(script)`: sintetički adapter; jedna grana se ponavlja, popis grana troši se redom;
- `SYNTHETIC_BRANCHES`, `SyntheticBranch`, `SyntheticAssistant`;
- `syntheticAnswer`: deterministični tekst odgovora, rezan na `maxResponseCodePoints`;
- prosljeđeno iz domene za rutu: `parseAssistantRequest`, `composeInstructions`, `buildPortInput`, `checkResponse`, `parseProviderEntry`, `AI_POLICIES`, `PURPOSE_CATALOG_VERSIONS` i njihovi tipovi.

## Što ne smije uvoziti

Smije uvoziti samo `domain`. Ne uvozi druge adaptere iz `external/` ni feature područja, ne čita okolinu i ne otvara mrežu. Popis je u [karti servera, §2](../../../docs/server-map.md#2-dopušteni-uvozi).
