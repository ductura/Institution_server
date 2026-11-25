# Tema završnog ili diplomskog rada (HTTP)

`createThesisTopicRoutesFor` (SRV-V16-TEMA-PRIJEDLOG) poslužuje tri rute iz `server/contracts/routes/thesis-topic.ts`: čitanje teme, prijedlog studenta (`PUT`) i odluku mentora (`POST .../decision`) na `/api/v1/works/{documentId}/thesis-topic`. Pristup odlučuje baza; adapter provjerava oblik zahtjeva i greške `ZD401`–`ZD422` pretvara u zatvorene riječi ugovora. Odgovori koriste `Cache-Control: no-store`.
