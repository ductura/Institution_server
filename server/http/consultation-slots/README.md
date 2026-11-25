# HTTP rute za termine konzultacija

GET s valjanom sesijom dohvaća otvorene termine rada s temom. POST traži termin, po želji s temom, a PATCH potvrđuje termin, nudi drugo vrijeme ili prihvaća protuprijedlog. Baza provjerava odnos korisnika prema radu i dopuštene prijelaze. Povlačenje, odbijanje i otkazivanje idu kroz `work.consultation-slot-close.post` (`../mentorship-consultations/`); ova ruta zatvoren termin izostavlja, a PATCH na njemu daje 409.
