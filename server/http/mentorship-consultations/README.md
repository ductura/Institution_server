# Otvaranje mentorstva, termini s pojedinostima i dogovoreni zadaci

SRV-MENTOR-1 (NF-6: MK-7, MK-3, MK-10, MK-5). Tanki HTTP adapter devet novih ruta (`server/contracts/routes/mentorship-consultations.ts`) nad `server/database/mentorship-consultations/`. Ugovor provjerava ulaz, baza odlučuje tko smije. Odbijanja slijede rute uz koje stoje: tuđe mentorstvo i zapisnik čitaju se kao 404, termin rada bez odnosa kao 403. Postojeće rute termina, zapisnika i obavijesti ostaju kakve jesu; obavijest nove vrste `mentorship_opened` ima svoj popis, a `notifications.list.get` je izostavlja.
