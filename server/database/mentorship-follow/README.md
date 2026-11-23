# mentorship-follow

Priključak baze za „Poruku sebi” i „Dokle sam stao” (MK-9), oznake „student je vidio” (MK-11) i pregled „Moji studenti” za mentora (MK-8, PG-9), SRV-MENTOR-3, migracija `20261214160000_mentorship_self_note_overview.sql`. Jedan poziv je jedna `withActor` transakcija nad jednim RPC-om sheme `collaboration`; tko smije odlučuje baza (bilješku i položaj čitanja samo student vlasnik rada, oznake student i nastavnici rada, pregled mentor otvorenog mentorstva). Ne čita i ne piše dokument.
