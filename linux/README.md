# Schmear tray app

A Linux tray app that shows what schmear knows (subscription pools, pace, status, the next lane per tier, running and recent delegations) and edits the tier list. It is a thin client: it runs `schmear usage --json` and `schmear tiers`, and holds no routing, usage-reading or tier-validation code.

## Requirements

- Qt 6.4 or later (Widgets, Network) and CMake 3.22 or later. On Ubuntu 24.04 or Debian: `sudo apt install cmake g++ qt6-base-dev libgl-dev`.
- A desktop with a system tray: KDE Plasma, or GNOME with the AppIndicator extension (on by default in Ubuntu). Without one, the app runs as a normal window, and closing it quits.
- `schmear` on your login shell's PATH (the app reads the environment of `$SHELL -ilc` once, so your shell's rc files count), 0.2.0 or later.

## Build and install

From the repo root:

```sh
cmake -S linux -B linux/build -DCMAKE_INSTALL_PREFIX="$HOME/.local" && cmake --build linux/build && cmake --install linux/build
```

This installs `~/.local/bin/schmear-tray`, a "schmear" entry in the app menu, and its icon. Launch it from the app menu or run `~/.local/bin/schmear-tray`; launching it again while it runs opens the running app's window. To uninstall, run `xargs rm < linux/build/install_manifest.txt`.

## Use

- Left-click the tray icon to show or hide the window. Right-click it for Open schmear and Quit. The window's close button hides it. The window refreshes at launch, every 60 seconds, and on Refresh; a refresh can take up to 90 seconds when schmear's 5-minute usage cache is stale.
- The icon shows the count of running delegations, and fills when a pool's pace is above 1 (quota there expires unused unless spent faster). Its tooltip says the same in words.
- Open at Login writes `~/.config/autostart/schmear-tray.desktop`, and turning it off removes that file.
- Edit Tiers… opens the tier editor. Save runs `schmear tiers set`, Reset to Defaults runs `schmear tiers reset`; schmear validates and its error is shown as is.

## Develop

From the repo root, after the build above:

```sh
QT_QPA_PLATFORM=offscreen ctest --test-dir linux/build --output-on-failure
QT_QPA_PLATFORM=offscreen linux/build/schmear-tray --render macos/Tests/SchmearKitTests/Fixtures/snapshot.json out.png [--dark]
QT_QPA_PLATFORM=offscreen linux/build/schmear-tray --render-tiers macos/Tests/SchmearKitTests/Fixtures/tiers.json out.png [--dark]
```

The tests read the macOS app's fixtures in place.
