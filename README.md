# KUKA KRL Edit

A Visual Studio Code extension to help write, understand, and maintain KUKA Robot Language (KRL) programs.

This extension is maintained by VDRobotics and is based on the original KUKA KRL Assistant project.

## Features

- Syntax highlighting (snippets and color coding)
- Document Symbols / Outline view for `DEF`, `DEFFCT` and `DEFDAT` blocks (Outline panel, Breadcrumbs, Ctrl+Shift+O)
- Go to definition for functions and variables (case-insensitive, like KRL itself)
- Find All References (`Shift+F12`, right-click → "Find All References") for functions, structs and variables across the workspace
- Folding for `DEF`/`DEFFCT`/`DEFDAT`, `IF`, `LOOP`, `FOR`, `WHILE`, `SWITCH`, `STRUC`, `REPEAT` and KUKA `;FOLD … ;ENDFOLD` blocks
- Hover to view function parameters
- Warning when a GLOBAL variable is missing a DECL, SIGNAL or STRUC
- Error when a variable name exceeds KUKA's 24-character limit
- Error when a variable name has invalid KRL identifier syntax
- Optional information diagnostic for identifiers that are not declared in the current KRL workspace index
- Autocompletion for variables after typing the variable name followed by '.'
- IntelliSense Autocompletion for Functions and their own Parameters

## Configuration

Each diagnostic can be toggled independently in `settings.json`. All default to `true`.

```json
{
  "kukaKrl.validation.variableNameLength": true,
  "kukaKrl.validation.variableNameSyntax": true,
  "kukaKrl.validation.undeclaredIdentifiers": false,
  "kukaKrl.validation.globalUsage": true,
  "kukaKrl.validation.defdatPublicGlobalRequired": true,
  "kukaKrl.validation.defdatNonPublicGlobalForbidden": true
}
```

Set any of them to `false` to silence the corresponding warning or error. Changes take effect immediately, without reloading the window.

## Installation

You can install the extension from the Visual Studio Marketplace after the first VDRobotics release is published.

## Repository

[Public Repo on GitHub](https://github.com/vdrobotics/KUKA-KRL-Edit)

## License

MIT
