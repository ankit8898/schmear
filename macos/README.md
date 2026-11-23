# Schmear menu bar app

A macOS menu bar app that shows what schmear knows (subscription pools, pace, status, the next lane per tier, running and recent delegations) and edits the tier list. It is a thin client: it runs `schmear usage --json` and `schmear tiers`, and holds no routing, usage-reading or tier-validation code.

## Requirements

- macOS 14 or later and Swift 6.2 or later (Xcode 26 or its Command Line Tools). Swift 6.1 crashes compiling the app.
- `schmear` on your shell's PATH (the app reads the environment of an interactive login shell once, so `.zshrc`, `.zprofile` and `.zshenv` all count), 0.2.0 or later.

## Build and run

```sh
macos/build.sh
open macos/build/Schmear.app
```

The app has no Dock icon. `build.sh` signs it with `SCHMEAR_SIGN_IDENTITY`, by default the first `Developer ID Application` identity in your keychain (hardened runtime), else ad hoc. With `SCHMEAR_NOTARY_PROFILE` set to a profile saved by `xcrun notarytool store-credentials`, it also notarizes and staples the app and writes `build/Schmear.zip` for distribution.

## Use

- Click the menu bar icon for the popover. It refreshes at launch, every 60 seconds, and on Refresh; a refresh can take up to 90 seconds when schmear's 5-minute usage cache is stale.
- The icon shows the count of running delegations, and fills when a pool's pace is above 1 (quota there expires unused unless spent faster).
- Open at Login starts the app when you log in.
- Edit Tiers... opens the tier editor. Save runs `schmear tiers set`, Reset to Defaults runs `schmear tiers reset`; schmear validates and its error is shown as is.

## Develop

```sh
cd macos && swift build && swift test
.build/debug/SchmearBar --render Tests/SchmearKitTests/Fixtures/snapshot.json out.png [--dark]
.build/debug/SchmearBar --render-tiers Tests/SchmearKitTests/Fixtures/tiers.json out.png [--dark]
```
