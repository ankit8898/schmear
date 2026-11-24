# Schmear tray app

A Linux tray app that shows what schmear knows (subscription pools, pace, status, the next lane per tier, running and recent delegations) and edits the tier list. It is a thin client: it runs `schmear usage --json`, `schmear tiers` and `schmear max-tasks` (and `schmear init --yes` when you click Reconnect), and holds no routing, usage-reading or tier-validation code.

To install it, see [Linux tray app](../README.md#linux-tray-app) in the main README. It needs `schmear` on your login shell's PATH; it reads the environment of `$SHELL -ilc` once, so your shell's rc files count.

## Build from source

Needs CMake 3.22+, a C++17 compiler and Qt 6.4+ (Widgets, Network, DBus); on Ubuntu 24.04 or Debian, `sudo apt install cmake g++ qt6-base-dev libgl-dev`. From the repo root:

```sh
cmake -S linux -B linux/build -DCMAKE_BUILD_TYPE=Release && cmake --build linux/build
cmake --install linux/build --prefix linux/build/stage && linux/build/stage/install.sh
```

`cmake --install` stages the release archive's layout; its `install.sh` installs it as the release block does.

## Use

- Launching `schmear-tray` again while it runs opens the running app's window.
- Left-click the tray icon to show or hide the window. Right-click it for Open schmear and Quit. The window's close button hides it. The window refreshes at launch, every 60 seconds, and on Refresh; a refresh can take up to 90 seconds when schmear's 5-minute usage cache is stale.
- The icon shows the count of running delegations, and fills when a pool's pace is above 1 (quota there expires unused unless spent faster). Its tooltip says the same in words. It gets an orange "!" badge, and its tooltip says "needs attention", when schmear isn't installed, an agent isn't connected to schmear, or no subscription has pools.
- An agent that isn't connected, as after a Homebrew upgrade, gets a line under the header with a **Reconnect** button. It runs `schmear init --yes` and then tells you which agents to restart.
- When the installed `schmear` is older than 0.4.0 (the app needs `maxTasks` and `hosts`), the popover says so, shows `brew upgrade schmear && schmear init --yes` and `npm i -g schmear && schmear init --yes` to copy, and the icon shows the warning.
- A `schmear` call that runs over 180 seconds is stopped and shown as an error.
- Open at Login writes `~/.config/autostart/schmear-tray.desktop`, and turning it off removes that file. That entry runs `schmear-tray --autostart`, which waits up to a minute for a panel that starts after it before falling back to a window.
- Edit Tiers… opens the tier editor. Save runs `schmear max-tasks <n>` (when changed) and `schmear tiers set`, Reset to Defaults runs `schmear tiers reset` and `schmear max-tasks reset`; schmear validates and its error is shown as is.

## Develop

From the repo root, after the build above:

```sh
QT_QPA_PLATFORM=offscreen ctest --test-dir linux/build --output-on-failure
QT_QPA_PLATFORM=offscreen linux/build/schmear-tray --render macos/Tests/SchmearKitTests/Fixtures/snapshot.json out.png [--dark]
QT_QPA_PLATFORM=offscreen linux/build/schmear-tray --render-tiers macos/Tests/SchmearKitTests/Fixtures/tiers.json out.png [--dark]
```

The tests read the macOS app's fixtures in place.
