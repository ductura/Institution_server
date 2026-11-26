# server/domain/qualitative-coding

Kvalitativno kodiranje vlastitog gradiva (SRV-V18-KODIRANJE-BAZA, val 18). Samo čiste funkcije bez I/O-a; iste su granice kao u migraciji `20261219390000_qualitative_coding.sql`, koja je mjerodavna.

- **Gradivo** (`material.ts`): vrsta `interview` ili `note`, naslov do 200 znakova, tekst do 100 000 znakova. Prijelomi redaka se pretvaraju u `\n`, kontrolni znakovi (osim prijeloma i tabulatora) su odbijeni. Odlomak je redak teksta, i prazan; broji se u znakovima, ne u bajtovima.
- **Sidro** (`anchor.ts`): označeni odlomak je odlomak, pomak početka i kraja (od 0, kraj isključen) i citat 1 do 500 znakova. Sidro vrijedi samo ako je citat točno taj dio retka; prazan citat i citat od samih razmaka ne vrijede.
- **Šifrarnik** (`codebook.ts`): naziv do 80, opis do 500 znakova, isti naziv (bez obzira na veličinu slova) je isti kod, premještanje koda. Redoslijed je vlasnikov, nikad po učestalosti (V18-8).
- **Izvoz** (`export.ts`): oblik `qualitative-export-v1`. Isti ulaz daje iste bajtove. Označeni odlomci idu redom šifrarnika, pa gradiva, pa teksta; brojači po kodu i gradivu su opis, bez poretka po broju.

Ništa ne zove pomoćnika i ništa ne predlaže kod (V18-3). Ne uvozi ništa izvan mape. Testovi: `qualitative-coding.test.ts`.
