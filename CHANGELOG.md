# Changelog

All notable changes to this project will be documented in this file.

---

## [1.8.0] - 2026-05-27
### Added
- New `kukaKrl.validation.variableNameSyntax` diagnostic. It reports invalid KRL variable identifiers in declarations, including names that do not start with a letter, names containing unsupported characters, and names that reuse reserved KRL keywords or predefined types.
- New experimental `kukaKrl.validation.undeclaredIdentifiers` diagnostic. It reports identifiers that are not declared in the current KRL workspace index as Information and is disabled by default.

### Fixed
- Variable-name validation now respects array brackets when splitting declaration lists, so declarations like `DECL INT arr[2,3], nextVar` are parsed correctly.
- Variable-name validation no longer reports valid machine-data system variable declarations like `DECL ADAP_ACC $ADAP_ACC=#STEP2`.
- Variable-name validation now treats `CONST` as a declaration modifier, so declarations like `DECL CONST CHAR MASREF_Modulname[6]` validate the actual variable name.
- Variable-name validation no longer treats KRL keywords/types as invalid variable names, because valid machine data can use names like `LOAD_DATA`, `OUT`, or `ERR`.
- `&` metadata lines such as `&COMMENT global points` are ignored by diagnostics.
- Experimental undeclared-identifier validation was hardened against real KUKA project data: direct `.dat` type declarations, common KRL system commands/functions, structure initializers, and single-quoted bit literals now avoid false positives.
- Added more KRL system commands/functions to the undeclared-identifier allow-list, including `REPEAT`, `UNTIL`, `PTP_REL`, `SWRITE`, and `ERR_RAISE`.
- Undeclared-identifier validation now builds a workspace-wide declaration index from `.src`, `.dat`, and `.sub` files, so cross-file array declarations such as `DECL KORREKTUR Korr_GT3_RS_16818_Dross[3]` are resolved in function calls.
- Added `IntToStrWithPrefix()` and `GET_COLLMON_SET()` to the undeclared-identifier allow-list.

---

## [1.7.1] - 2026-05-08
### Added
- Four `kukaKrl.validation.*` settings to toggle individual diagnostics on or off, all defaulting to `true`:
  - `variableNameLength` — 24-character variable name limit (Error)
  - `globalUsage` — `GLOBAL` keyword usage check (Warning)
  - `defdatPublicGlobalRequired` — `DEFDAT … PUBLIC` requires `GLOBAL` declarations (Warning)
  - `defdatNonPublicGlobalForbidden` — non-PUBLIC `DEFDAT` forbids `GLOBAL` declarations (Error)

  Toggling a setting clears stale diagnostics across open files immediately, no reload required. The two server-side toggles (`defdat*`) are pushed to the language server via a `custom/setValidationConfig` notification.

---

## [1.7.0] - 2026-05-07
### Added
- Folding ranges for KRL block constructs: `DEF`/`DEFFCT`/`DEFDAT`, `IF`, `LOOP`, `FOR`, `WHILE`, `SWITCH`, `STRUC` and `REPEAT`. Also folds the KUKA-style `;FOLD … ;ENDFOLD` editor blocks that appear in machine-generated code.
- Recognize uppercase file extensions `.SRC`, `.DAT` and `.SUB` in addition to the lowercase variants — KUKA controllers commonly produce uppercase filenames.

---

## [1.6.0] - 2026-05-07
### Added
- Find All References (`Shift+F12`, right-click → "Find All References" / "Go to References", peek view via `Alt+Shift+F12`). Case-insensitive workspace-wide search across `.src`, `.dat` and `.sub` files. Skips line comments, subvariable accesses (`foo.bar`) and system variables (`$foo`, `#foo`). Honors the LSP `includeDeclaration` flag.

---

## [1.5.0] - 2026-05-07
### Added
- Document Symbols / Outline support for `DEF`, `DEFFCT` and `DEFDAT` blocks. Functions and data modules now appear in the Outline view, in Breadcrumbs, and via the symbol picker (Ctrl+Shift+O).

### Fixed
- `Go to Definition` failed when the symbol was written with a different case than its declaration. KRL is case-insensitive, but variable, struct and function lookups compared names strictly. Now all lookups are case-insensitive, and the jump position is computed correctly even when the file uses a different casing than the call site.

---

## [1.4.6] - 2025-08-24
### Fixed
- Fix issue with variables that could contain the string "Global" and trigger the PUBLIC DEFDAT error.

---

## [1.4.5] - 2025-08-24
### Fixed
- Fix issue with global variables inside a DEDFAT error

---

## [1.4.4] - 2025-07-28
### Fixed
- Fix warning for DECL variable with GLOBAL if a predefined type is used

------

## [1.4.3] - 2025-07-28
### Fixed
- Autocompletion via Intellisense didn't show Keywords when written

---

## [1.4.2] - 2025-07-28
### Fixed
- `Go to Definition` didn't work properly for variable or custom variable type
- `Go to Definition` will first check inside the same DEF, DEFCT if the variable is declare, then will check globally

---

## [1.4.1] - 2025-07-25
### Fixed
- Autocompletion with variables only shows now subvariables with '.', not declared functions

---

## [1.4.0] - 2025-07-25
### Added
- Autocompletion via Intellisense for functions with respectives params

### Removed
- Warning for GLOBAL ENUM that don't required DECL

---

## [1.3.1] - 2025-07-25
### Other
- Update ReadMe and Changelog

---

## [1.3.0] - 2025-07-25
### Added
- Extract variables from DECL, STRUC, and ENUM.
- Autocompletion for variables after typing the variable name followed by '.'.

### Fixed
- Errors and warnings were displayed multiple times; now they appear only once until cleared by the user.

### Other
- Refactored and cleaned up server and client code.

---

## [1.2.0] - 2025-07-24
### Added
- Error if a variable length is more than 24 characters
- Error if a GLOBAL is used without DECL, SIGNAL, STRUC
- Check all files for errors when opening a workspace or at VS Code startup.

---

## [1.1.1] - 2025-07-23
### Added
- No action if the clicked function is already on the DECL line.

### Fixed
- `Go to Definition` sometimes didn't work with function
- `Go to Definition` sometimes performed a peek instead of a go-to on variables.

---

## [1.1.0] - 2025-07-23
### Added
- Basic cross-file support for variable declarations using `DECL`, `SIGNAL`, and `STRUC`.
- `Go to Definition` now supports variables across multiple files.

---

## [1.0.0] - 2025-07-22
### Added
- Initial release.
- Syntax highlighting for KUKA KRL.
- Basic `Go to Definition` support for function only.
- Snippet support for KRL keywords.
