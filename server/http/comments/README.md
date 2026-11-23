# comments

HTTP rub odgođenih komentara, banke komentara i promjena od zadnjeg pregleda (SRV-1703, M6.7; D-51, N-03, N-05). Tanki rub nad `server/database/comment-delay` i `server/database/teacher-notes`: sesija, oblik zahtjeva i zatvoreni odgovori; tko smije odlučuje baza (odnos prema radu, ne uloga).

| Ruta                                                        | Svrha                                                                                                     |
| ----------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `GET`, `POST /api/v1/works/{documentId}/comment-drafts`     | nacrti komentara nastavnika koje student ne vidi                                                          |
| `DELETE /api/v1/comment-drafts/{commentId}`                 | autor odbacuje nacrt                                                                                      |
| `POST /api/v1/works/{documentId}/comments/publish`          | autor objavljuje sve svoje nacrte na radu odjednom                                                        |
| `POST /api/v1/works/{documentId}/comments/publish-selected` | isto, ali samo ako `draftIds` točno navodi nacrte koje je autor vidio; inače 409 i ništa se ne objavljuje |
| `GET`, `POST /api/v1/teacher/comment-bank`                  | banka komentara nastavnika (spremljeni predlošci SRV-8B), privatna                                        |
| `DELETE /api/v1/teacher/comment-bank/{entryId}`             | uklanjanje unosa iz banke                                                                                 |
| `POST /api/v1/works/{documentId}/review`                    | bilježi trenutačnu reviziju rada kao pregledanu                                                           |
| `GET /api/v1/works/{documentId}/changes-since-review`       | razlika po blokovima od zadnjeg pregleda do trenutačne revizije (SRV-9E)                                  |

Student nema nijednu od ovih ruta: nacrt, banka i oznaka pregleda nisu pogled na rad. Čitanje promjena piše redak dnevnika pristupa kao replay (usporedba čita izvor replaya); prije prvog pregleda i kad nema promjena usporedba se ne traži.
