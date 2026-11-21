# Pravno zadržavanje

`createLegalHolds` poziva `app.legal_holds`, `app.place_legal_hold` i `app.release_legal_hold`. Ovlast (potvrđeni admin ustanove) i pravilo da zadržavanje nikad ne skida onaj tko ga je postavio provjerava baza; adapter samo prevodi njezine kodove (`ZD401`, `ZD403`, `ZD404`, `ZD409`, `ZD422`) u stanja i provjerava oblik redaka. Zadržavanje koje je skinuo operater ima `releasedAt`, a `releasedBy` ostaje `null`.
