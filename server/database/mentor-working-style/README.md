# Kako mentor radi

Dva RPC-a glavne baze (F4-MEN-R09-SRV): mentor upisuje ili zamjenjuje vlastiti tekst (1 do 1000 znakova), a student s mentorstvom u tijeku ga čita. Tablica `institution.mentor_working_style` nema izravnih prava za aplikacijsku ulogu. Tuđe, nepostojeće i bez mentorstva je ZD403, a HTTP sloj za čitanje odgovara 404.
