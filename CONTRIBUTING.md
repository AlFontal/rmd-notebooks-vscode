# Contributing

## Development

Use Node.js 22 or newer.

```bash
npm install
npm run compile
npm test
```

`npm test` runs both unit tests and the VS Code extension-host suite.

## Targeted smoke tests

For R startup and `renv` behavior:

```bash
npm run smoke:renv
```

For vscode-R workspace-watcher integration:

```bash
npm run smoke:vscode-r
```

## Manual visual testing

```bash
npm run dev:visual
npm run dev:visual:rmd
npm run dev:example
npm run dev:example:rmd
```

Example documents live in:

- `test/manual-workspace/example.qmd`
- `test/manual-workspace/example.rmd`

## Packaging

Marketplace and Open VSX builds differ in how vscode-R is declared:

```bash
npm run package:vsix:marketplace
npm run package:vsix:openvsx
```

The Marketplace variant keeps vscode-R as a hard dependency. The Open VSX variant removes that dependency so Positron and other compatible hosts can use their own R support.

To create a shareable test build from the current branch:

```bash
npm run package:vsix:test
```

## CI and releases

GitHub Actions runs repository checks and the VS Code extension-host suite. Pull requests produce branch-and-SHA-named `.vsix` artifacts for manual testing.

The release workflow verifies that the tag matches `package.json`, builds the extension, attaches the VSIX to the GitHub release, and publishes release tags to the VS Code Marketplace and Open VSX.

On macOS, the VS Code extension-host tests can fail when launched from a restrictive sandbox. If that happens, run `npm run test:vscode` from a normal local shell.
