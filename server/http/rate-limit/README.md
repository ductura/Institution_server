# Ograničenje broja zahtjeva

Server ograničava broj zahtjeva po IP adresi prije usmjeravanja. Za rute koje traže prijavu provjerava račun kroz postojeći čitač sesije i primjenjuje zasebnu kvotu po operaciji API-ja. Sesije istog računa u istoj ustanovi dijele kvotu. Promjena parametra putanje ili upita ne stvara novu kvotu. Javne rute, prijava i odjava podliježu IP ograničenju. Odgovor 429 šalje `Retry-After` u cijelim sekundama.

Postavi varijable okruženja `DUCTURA_RATE_LIMIT_<KLASA>_PER_IP` i `DUCTURA_RATE_LIMIT_<KLASA>_PER_ACCOUNT`. Vrijednosti su cijeli brojevi od 1 do 100000. Server odbija pokretanje ako je zadana nevaljana vrijednost.

| Klasa     | Zadano po IP-u | Zadano po računu i operaciji |
| --------- | -------------: | ---------------------------: |
| `LOGIN`   |             30 |                            — |
| `ENROLL`  |             60 |                           10 |
| `SAVE`    |           1200 |                          120 |
| `DEFAULT` |           3000 |                          300 |

IP kvote nadopunjuju se kroz minutu. Minuta za račun počinje prvim zahtjevom u toj kvoti. Svaki proces vodi vlastite kvote u memoriji. Pri 50 000 aktivnih parova račun–operacija nove kvote čekaju najbliži istek.
