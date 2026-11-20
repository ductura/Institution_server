# Čitanje postavki

`GET /api/v1/settings/catalogue` daje katalog uz živu sesiju. `GET /api/v1/settings/values` daje spremljene i naslijeđene vrijednosti u opsegu tražene razine.

Na razini `institution` administrator dobiva sve postavke svoje ustanove. Potvrđeni nastavnik i student s aktivnim upisom ili mentorstvom dobivaju samo `citation.style` i `lekta.profile` svoje ustanove, uključujući zadane vrijednosti kad nema spremljenih redaka.
