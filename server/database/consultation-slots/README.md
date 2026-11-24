# Termini konzultacija

RPC-i glavne baze čitaju termine s temom (`consultation_slot_details`, samo otvorena stanja), spremaju zahtjev s neobveznom temom ili izvršavaju prijelaz; nakon pisanja termin se čita u istoj transakciji. Identitet dolazi iz sesije vezane uz transakciju. Adapter pretvara oba vremena u UTC za HTTP odgovor.
