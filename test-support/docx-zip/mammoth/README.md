# DOCX fixtures from mammoth.js (ISTR-6)

Six `.docx` files from
[mwilliamson/mammoth.js](https://github.com/mwilliamson/mammoth.js), directory `test/test-data`,
commit `5171a9072f8b7343ab1c9ed3a15d6d372cb59b67`. License: BSD-2-Clause, Copyright (c) 2013,
Michael Williamson; the full text is in [LICENSE](LICENSE) and must stay with the files.

`endnotes.docx` and `external-picture.docx` are byte-for-byte copies. In the other four, only personal
metadata was replaced (no personal data in fixtures): `dc:creator` and `cp:lastModifiedBy` in
`docProps/core.xml` became `Test Author`, and in `comments.docx` the comment author and initials
became `Test Author` / `TA`. All other parts are unchanged; the archives were rewritten, so their
hashes differ from upstream. Upstream SHA-256 of the originals: `strict-format`
`86d90f50d8fd3310c4079291c6622878d8f4d8864d665d1e34841f407e7b7662`, `comments`
`adc9f524d176f562db830c346c1e9e21c6a6aa6768d9c09892a423f1257fe17c`, `footnotes`
`a3d786ba3ad53833dd3d5e01bd55e93b628c1287d8f9210eb94cb7533f270306`, `tables`
`9f75a82d36530d91989a43fcb8940f2e753051787714cecbf6a1f49a22e58ded`. The table below lists the
hashes of the files in this folder.

The library mammoth is not a dependency; only these test inputs are used. Their text is invented
by the mammoth authors (no real student work, no personal data). The expected outcome of each one
is pinned by `server/import/docx/mammoth-fixtures.test.ts`.

| File                    | SHA-256                                                            | Outcome of `readDocx`                                               |
| ----------------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------- |
| `strict-format.docx`    | `1e8b855d57ebfc4210ccb68261be28726a44a480916cdfe5d75e517e87896f78` | `PACKAGE_INVALID` (Strict OOXML namespaces are not in the contract) |
| `comments.docx`         | `a94b72df9a354fa1e24a87d540583c47f8d28e5166de13a2d6de4558059e07fd` | imported; comments counted as a trace, their text not imported      |
| `footnotes.docx`        | `220f80c437b26c5633ad1561ec22421d9d52e1a22da40d935a7d8a170d029565` | imported; footnote text not imported                                |
| `endnotes.docx`         | `8b0275a08427605e57e0ca7596bc89fb4c00e4b9a5cdae2b1941c619c2496014` | imported; endnote text not imported                                 |
| `tables.docx`           | `87ec522686fb1461d12f8b13a73c9659a6a5c34abb133190f68da8960312c655` | imported; cell text becomes paragraphs in reading order             |
| `external-picture.docx` | `2f5dbcf27f3dcec02e81535de21b81a2719e0acfd73158750cb7f91249e628f5` | `EXTERNAL_RESOURCE`, whole import refused, nothing fetched          |
