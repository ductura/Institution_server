# Otvaranje mentorstva, termini s pojedinostima i dogovoreni zadaci

SRV-MENTOR-1 (NF-6: MK-7, MK-3, MK-10, MK-5). RPC-i glavne baze iz migracije `20261215110000_mentorship_opening_consultations.sql`; identitet dolazi iz sesije vezane uz transakciju, a funkcije odlučuju tko smije (pristup iz odnosa, C-23).

- `app.open_mentorship`: nastavnik otvara mentorstvo studentu svoje ustanove (vrsta rada, neobavezna tema); student dobiva obavijest vrste `mentorship_opened`.
- `app.student_mentorships` i `institution.list_mentorship_notifications`: studentova otvorena mentorstva i njegove obavijesti o otvaranju.
- `institution.consultation_slot_details`, `request_consultation_slot_detail`, `close_consultation_slot`: termin s temom, pripremom (zapis o unosu, ne o autorstvu) i radnjama povlačenja, odbijanja i otkazivanja.
- `collaboration.list_consultation_tasks`, `add_consultation_task`, `mark_consultation_task`: dogovoreni zadaci zapisnika; upisuje ih i označava samo nastavnik rada, student čita; ništa se ne mijenja ni ne briše.

Pisanje vraća redak koji za upisani zapis daje odgovarajuće čitanje, u istoj transakciji.
