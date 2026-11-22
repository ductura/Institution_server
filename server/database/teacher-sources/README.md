# teacher-sources (baza)

Port baze za nastavnikove izvore (SRV-1605, 20261213100500): preporuka izvora na radu, obvezna
literatura kolegija, zahtjev za potvrdu izvora s rokom, oznaka pregledane literature i čitanje
potvrda izvora. Jedan RPC po operaciji kroz `withActor`; odbijanja su ishodi, ne iznimke. Piše samo
nositelj kolegija (ili mentor rada); suradnik i ostali čitatelji samo čitaju.
