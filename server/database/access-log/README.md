# Dnevnik pristupa radu (SRV-1706, plan M10.4)

- `index.ts`: čitač za `work.access.get`. Jedno čitanje `app.read_my_access_log` kroz postojeći port `../my-access-log.ts` (DAN-294), koji provjerava vlasnika, kursor i svaki redak. Redci po 5 minuta grupiraju se u dane po zagrebačkom vremenu (`days.ts`); dan nosi samo datum i retke, nikad broj posjeta ni trajanje (D-274 MQ10). Površina `declaration` (20261208100000) čuva se iz samog retka, jer port još zna samo površine do `submitted_text`.
- `work-read-paths.ts`: popis M10.4-P02. Svaka funkcija glavne baze koju web uloga (`ductus_app`) smije pozvati i koja, izravno ili preko funkcije koju zove, dohvaća tablicu s tekstom rada, nalazi se ili u `WORK_READ_PATHS` (piše redak u `audit.access_log` kad rad ne čita vlasnik, s površinama i pgTAP dokazom) ili u `NOT_A_PERSON_READ` (samo vlasnik, pisanje ili odgovor bez sadržaja, s razlogom). Uz svaku su datoteke `server/` koje je zovu.
- `work-read-paths.pg.integration.test.ts` obilazi katalog migrirane baze: skup funkcija koje dohvaćaju sadržaj jednak je popisu, svaka s popisa `WORK_READ_PATHS` dolazi do `audit.record_work_opening` s navedenim površinama, a čitanje nastavnika piše redak dok čitanje vlasnika i drugog studenta ne piše ništa.
- `access-log.test.ts` drži pozivatelje u `server/` jednakima popisu i provjerava da navedeni pgTAP dokaz čita `audit.access_log`.

Nova funkcija koja vraća tekst ili sažetak rada ne prolazi test dok se ne upiše u jedan od dva popisa.
