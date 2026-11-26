# comments

HTTP rub odgođenih komentara, banke komentara i promjena od zadnjeg pregleda (SRV-1703, M6.7; D-51, N-03, N-05). Tanki rub nad `server/database/comment-delay` i `server/database/teacher-notes`: sesija, oblik zahtjeva i zatvoreni odgovori; tko smije odlučuje baza (odnos prema radu, ne uloga).

| Ruta                                                        | Svrha                                                                                                            |
| ----------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `GET`, `POST /api/v1/works/{documentId}/comment-drafts`     | nacrti komentara nastavnika koje student ne vidi                                                                 |
| `POST /api/v1/works/{documentId}/comment-drafts/v2`         | nacrt niti s neobaveznom vrstom (`must`, `sugg`, `q`, `praise`) i sa sidrom `null` (opći komentar na cijeli rad) |
| `DELETE /api/v1/comment-drafts/{commentId}`                 | autor odbacuje nacrt                                                                                             |
| `POST /api/v1/works/{documentId}/comments/publish`          | autor objavljuje sve svoje nacrte na radu odjednom                                                               |
| `POST /api/v1/works/{documentId}/comments/publish-selected` | isto, ali samo ako `draftIds` točno navodi nacrte koje je autor vidio; inače 409 i ništa se ne objavljuje        |
| `GET`, `POST /api/v1/teacher/comment-bank`                  | banka komentara nastavnika (spremljeni predlošci SRV-8B), privatna                                               |
| `PUT /api/v1/teacher/comment-bank/{entryId}`                | zamjena teksta, vrste i oznake (`label`, do 40 znakova, `null` = bez) vlastitog unosa; tuđi ili nepostojeći 404  |
| `DELETE /api/v1/teacher/comment-bank/{entryId}`             | uklanjanje unosa iz banke                                                                                        |
| `POST /api/v1/works/{documentId}/review`                    | bilježi trenutačnu reviziju rada kao pregledanu                                                                  |
| `GET /api/v1/works/{documentId}/changes-since-review`       | razlika po blokovima od zadnjeg pregleda do trenutačne revizije (SRV-9E)                                         |

Vrsta komentara (EDI-R20, Q-6) ide uz nacrt i vidi se u `work.comment-drafts.get` (autor) i u popisu komentara (`collaboration.comments.post`, radnja `list`; student nakon objave) kao neobavezno polje `kind`; `null` je bez vrste. Odgovor na nacrt (`threadId`) ostaje na starom `POST`.

Student nema nijednu od ovih ruta: nacrt, banka i oznaka pregleda nisu pogled na rad. Čitanje promjena piše redak dnevnika pristupa kao replay (usporedba čita izvor replaya); prije prvog pregleda i kad nema promjena usporedba se ne traži.
