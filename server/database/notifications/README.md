# Pohrana obavijesti

Adapter pretvara vrijeme iz PostgreSQL-a u ISO 8601. Dva RPC-a nad postojećom tablicom `institution.notification` primatelja i ustanovu uzimaju iz sesije. Tablica zadržava prisilni RLS i pristup samo za vlasničku ulogu. Pozivi aplikacijske uloge izvršavaju samo pripadajući RPC.

Stvaranje podsjetnika zaključava primatelja do kraja transakcije. Ako je zaključavanje zauzeto, dohvat vraća postojeće zapise. Ako transakcija ne uspije, zapis podsjetnika se povlači s njom.
