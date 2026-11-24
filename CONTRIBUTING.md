# Contributing

## Dev loop

```
npm ci
npm run check    # type check, lint, offline tests
npm run build
```

`npm run test:live` uses real logins and spends real quota. It runs only when the guard in `test/live/guard.ts` is satisfied and is never run in CI.

## Design record

`docs/spec.md` is the design record; comments in `src/` cite its § numbers. A behaviour change updates it in the same PR. `docs/probes/` holds the probe scripts behind the research-log entries in the spec and `docs/research/`.

## AI-assisted contributions

Welcome. The author is responsible for every line and must have run `npm run check`.

## Releasing

One-time setup, by the owner:

1. Create the GitHub repository `kevin1chun/schmear` (it must match `repository` in `package.json` for npm provenance), then enable private vulnerability reporting (Settings, Security), which SECURITY.md relies on.
2. Create a `release` environment with a required reviewer; `.github/workflows/release.yml` publishes from it.
3. On npmjs.com, add this repository's `release.yml` as the trusted publisher for `schmear`. Trusted publishing may refuse the first publish of a new package name; then publish that version by hand with 2FA (`npm publish`) and add the trusted publisher afterwards.
4. Protect `main` and add a tag ruleset that limits who can push `v*` tags.
5. Create the public repository `kevin1chun/homebrew-tap` with `Formula/schmear.rb` and `Casks/schmear.rb`, and give it a write deploy key. In the `release` environment, add `HOMEBREW_TAP_DEPLOY_KEY` (that key's private half), `MACOS_SIGNING_P12` (the Developer ID Application certificate and key, base64) and `MACOS_SIGNING_P12_PASSWORD`, and `ASC_KEY_ID`, `ASC_ISSUER_ID` and `ASC_PRIVATE_KEY_P8` (an App Store Connect team API key with Developer access).

Each release: bump `version` in `package.json`, move the CHANGELOG's Unreleased entries under `## [X.Y.Z] - YYYY-MM-DD`, commit, and push the tag `vX.Y.Z`. The workflow fails unless the tag equals the package version. After npm, it creates a draft release, builds and attaches the Linux archives (`schmear-tray-linux-{x86_64,aarch64}.tar.gz` with `.sha256`) and the notarized `Schmear.zip`, publishes the release, then points the tap's formula and cask at the new version. A job that fails before publishing leaves the release a draft; rerun failed jobs. Homebrew installs refuse npm packages published within the last day, so the publish job fails while any dependency is less than a day old; rerun it once they are.

## Conduct

Participation follows the [code of conduct](CODE_OF_CONDUCT.md).

## License

Contributions are licensed under MIT, the project's license. There is no CLA.
