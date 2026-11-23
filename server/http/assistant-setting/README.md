# assistant-setting

HTTP edge of `institution.assistant-setting.get` (SRV-ADMIN-3, NF-7 OA-9): a confirmed
administrator of the institution reads the assistant setting of its faculty. The domain is
`server/institution/assistant-setting.ts`; the switch is the versioned faculty setting
`config/faculties/<faculty>.json` (OC-1) and changes only through the owner's PR, never here.
No provider and no model is named.
