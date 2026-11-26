# Povjerenstvo završnog ili diplomskog rada (HTTP)

`createThesisCommitteeRoutesFor` (SRV-V16-POVJERENSTVO-ZAPIS) poslužuje dvije rute iz `server/contracts/routes/thesis-committee.ts`: čitanje popisa i zamjenu cijelog popisa (`PUT`, samo administrator) na `/api/v1/works/{documentId}/thesis-committee`. Pristup odlučuje baza; adapter provjerava oblik zahtjeva i greške `ZD401`–`ZD422` pretvara u zatvorene riječi ugovora. Povjerenstvo je samo popis: nikakvo pravo čitanja rada. Odgovori koriste `Cache-Control: no-store`.
