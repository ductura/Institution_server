# Podudaranje s odgovorom pomoćnika

`compareAssistantResponses` prima blokove predane revizije poredane kao u `textBlocksOf`, s pripadajućim ID-ovima blokova, te odgovore iz opsega iste predaje. `aiMatch` je spreman za zapis `provenance-share-v1` i sadrži raspone u izvornim Unicode točkama te obveznu napomenu. `witnesses` je interni rezultat. Uz svaki podudarni raspon koji proširuje uniju sadrži ID jednog odgovora i položaje u normaliziranom bloku. Za zapis i prikaz koristi se samo `aiMatch`.

`readFakeAssistantResponses` služi testovima s izmišljenim porukama. Prima snimku trenutno dostupnih poruka i opseg predaje iz potvrde. Uspoređuje kanonske UTC timestampe sa šest decimala i isključuje poruke zapisane točno u trenutku zahtjeva ili nakon njega.

Sufiksni automat indeksira obrnuti tekst predanih blokova i zasebno prolazi svaki odgovor. Time za svaki početak riječi nalazi najdulje moguće podudaranje pa ga skrati do kraja riječi. Rad je linearan u ukupnoj duljini ulaza, uz memoriju razmjernu predanom radu i najduljem odgovoru. Testovi pokrivaju vektore iz ugovora, rubne slučajeve i izvedbu.

Izvor je [ugovor provenance-share-v1](../../../docs/contracts/provenance-share-v1.md), odjeljci 2, 3.2 i 6.
