### 0.1.0

* **DV_PROPORTION inheritance corrected.** `DV_PROPORTION` now derives from `DV_AMOUNT` (previously incorrectly derived from `PROPORTION_KIND`), bringing the FHIR logical model in line with the openEHR RM hierarchy.
* **`PROPORTION_KIND` removed as a standalone resource.** It is treated as an abstract enumeration used like a foundation type rather than a first-class structure; implementers should rely on the `proportion-kind` CodeSystem/ValueSet bindings instead of the previously-published structure definition.
* **`proportion-kind` CodeSystem enriched.** A new `constant-integer-value` property has been added to each concept (`pk_ratio`=0, `pk_unitary`=1, `pk_percent`=2, `pk_fraction`=3, `pk_integer_fraction`=4) so implementers can round-trip the canonical openEHR integer constants.
* **New CodeSystems and ValueSets published for openEHR support terminology.** Added `countries` (ISO 3166-1), `languages` (ISO 639-1), `media-types` (IANA), `time-definitions`, and `term-mapping-match`, each with a matching ValueSet. These were previously referenced only by name and are now resolvable resources in the IG.
* **Required bindings added to data-type elements.** `DV_ENCAPSULATED.charset`/`.language`, `DV_MULTIMEDIA.media_type`/`.compression_algorithm`, `DV_TEXT.language`, and `TERM_MAPPING.match` now carry `required` ValueSet bindings to the corresponding openEHR code systems. Implementers must populate these elements with codes drawn from the bound ValueSets.
* **`TERM_MAPPING.match` retyped from `string` to `code`.** The element is now a closed coded value bound to the new `term-mapping-match` ValueSet (`>`, `=`, `<`, `?`); free-text values are no longer permitted.
* **`web-source` extension added to existing openEHR CodeSystems.** `character-sets` and `compression-algorithms` now link back to the canonical openEHR support-terminology specification, and their descriptions have been expanded from placeholder text.
* **Bug fixes.**
    * `DV_PROPORTION.is_equal`: documentation typo `DV_AMOUNT` corrected to `DV-AMOUNT` to match the canonical type id used elsewhere in the IG.
    * `ITEM_LIST.named_item`: replaced curly quotes with straight quotes in the description so the rendered narrative matches the source text.
