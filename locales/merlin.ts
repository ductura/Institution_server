// The words of the Merlin roster and its files (SRV-1109, D-286): the CSV
// header in the order of the row fields, the two answers of a yes-or-no cell
// and the labels the export prints in the PDF and DOCX of a submitted work.
export const merlinHr = {
  csvHeader: [
    "Prezime",
    "Ime",
    "Predano",
    "Vrijeme predaje",
    "Nakon roka",
    "Datoteka PDF",
    "Otisak PDF (SHA-256)",
    "Datoteka DOCX",
    "Otisak DOCX (SHA-256)",
  ],
  yes: "da",
  no: "ne",
  exportLabels: {
    listing: "Ispis",
    boxes: {
      definition: "Definicija",
      theorem: "Teorem",
      lemma: "Lema",
      corollary: "Korolar",
      example: "Primjer",
      remark: "Napomena",
      proof: "Dokaz",
    },
  },
} as const;
