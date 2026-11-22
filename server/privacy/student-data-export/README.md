# server/privacy/student-data-export

Posao izvoza podataka studenta (SRV-1308; plan M10.5; D-271 MQ02), nad bazom iz SRV-1307.

## Što radi

`runStudentDataExportPass` za svaki odobreni izvoz, od najstarijeg: pročita sadržaj osobe (port workera), složi paket (`buildStudentDataExportPackage`), spremi ga kroz port pohrane, stvori jednokratni token od 32 slučajna bajta, označi izvoz spremnim sa SHA-256 tokena (sam token se nikad ne sprema) i preda token portu dostave. Paket se sprema prije nego što izvoz postane spreman, pa spremna poveznica uvijek ima paket; pad između ostavlja izvoz odobrenim i sljedeći prolaz zapiše iste bajtove. Na kraju prolaza istječu poveznice starije od 24 sata. Jedan neuspjeli izvoz ne zaustavlja ostale; prolaz javlja samo zatvorene razloge, nikad id, token ni sadržaj.

`buildStudentDataExportPackage` slaže deterministički ZIP (`writeZip`: spremljeni unosi, fiksno vrijeme, imena u fiksnom redu): isti sadržaj, ishodište i oznake daju iste bajtove.

| Datoteka                                    | Sadržaj                                                                                        |
| ------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `manifest.json`                             | format, popis predaja i svaka datoteka sa SHA-256                                              |
| `predaje/NNN-<predaja>/predani-tekst.json`  | točan predani tekst (`.txt` kad tekst nije JSON objekt)                                        |
| `predaje/NNN-<predaja>/potvrda-predaje.pdf` | PDF potvrde predaje istim crtačem kao studentova potvrda; nema ga dok potvrda čeka potpis      |
| `biljeske.json`                             | studentove bilješke uz predaje                                                                 |
| `dnevnik-pristupa.json`                     | tko je otvarao studentove radove, po danima Europe/Zagreb (isti model kao S-42, bez zbrajanja) |

## Tko ga zove

Proces workera (još nema vlastiti sastavljač; vidi „Otvorene stavke”). Preuzimanje poslužuje `server/http/student-data-export`.

## Koje podatke dira

Samo kroz portove: čitanje workera (`server/database/student-data-export`, `app.worker_student_data_export_*`), pohranu paketa i dostavu poveznice. Sat, mrežu ni bazu ne otvara sam.

## Otvorene stavke

- Posao još nije spojen u proces workera ni u raspored; port dostave poveznice (e-pošta ili referada) čeka odluku o kanalu.
- Korak isteka vraća samo broj, pa paket istekle poveznice ostaje u pohrani do čišćenja; preuzimanje briše svoj paket.
