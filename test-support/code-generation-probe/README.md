# test-support/code-generation-probe

Proba za DAN-772 ([server/code-generation.integration.test.ts](../../server/code-generation.integration.test.ts)). Učitava se s `node --import` prije ulazne točke servera, pa radi u istom procesu i istom kontekstu kao kod servera. Pokušava izvršiti string kao kod (`Function`, `new Function`, konstruktor obične, asinkrone i generatorske funkcije, neizravni `eval`) i na stdout piše jedan redak `{"event":"codegen.probe","results":{…}}`: za svaki pokušaj `ran` ili ime greške.

Ne ide u build, ne izvozi se i proizvodni kod ga ne uvozi.
