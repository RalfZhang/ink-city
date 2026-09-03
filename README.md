<div align="center">
  <img src="docs/logo.png" width="120" height="120" alt="InkCity" />
  <h1>InkCity</h1>
  <p>Your desktop wallpaper, redrawn every day as the road map of a different city.</p>
</div>

---

InkCity is a small cross-platform (macOS + Windows + Linux) desktop app. Every day at midnight it picks a city, renders its road network as an ink-on-paper map sized to your screen, and sets it as your wallpaper.

## Installation

Open https://github.com/RalfZhang/ink-city/releases/latest/
- For windows: download `InkCity_x.x.x_x64-setup.exe ` and run the installer.
- macOS: download `InkCity_x.x.x_universal.dmg `, open it, and drag the app to your Applications folder.
- Linux (x86_64): download `InkCity_x.x.x_amd64.deb` (Debian/Ubuntu) or `InkCity-x.x.x-1.x86_64.rpm` (Fedora/openSUSE) and install it with your package manager. Built against Ubuntu 24.04, so glibc 2.39 or newer.

### Linux notes

Setting the wallpaper is not a standard Linux API, so support is per-desktop. **GNOME** (including Ubuntu, Pop!\_OS, Zorin), **KDE Plasma** and **XFCE** are the supported set, on both X11 and Wayland. Cinnamon, MATE, Deepin, LXQt/LXDE and the wlroots compositors (sway, Hyprland, river, niri — via `swww`, `hyprpaper` or `swaybg`) are handled on a best-effort basis; if yours isn't covered, [open an issue](https://github.com/RalfZhang/ink-city/issues) saying which desktop you use.

Two more things worth knowing:

- InkCity lives in the system tray. **GNOME 45+ ships no tray** unless you install the [AppIndicator extension](https://extensions.gnome.org/extension/615/appindicator-support/) — without it InkCity opens its settings window at login instead of hiding, so you always have a way in, but installing the extension gives you the intended experience.
- **There are no in-app updates on Linux.** The packages are owned by your package manager, not by InkCity, so the update controls are hidden and nothing phones home for a version check — install a newer release the same way you installed this one. Watch the [releases page](https://github.com/RalfZhang/ink-city/releases) (or subscribe to it) to hear about new versions. There's no AppImage yet, which is what would normally carry self-updates; see [issue tracker](https://github.com/RalfZhang/ink-city/issues) if you want one.

## Features

- **A new city every day** — drawn from ~1000 of the world's most notable cities, with no city repeating within a month and no country within five days.
- **Real road data** — road geometry from OpenStreetMap, rendered to cover-fit your screen without stretching.
- **Themeable maps** — Light / Dark / Follow-system map palettes, each with customizable background and line colors, plus three line-weight presets (Minimal / Standard / Bold).
- **Mondrian mode** — an experimental repaint of the very same street grid as a De Stijl composition: black roads on warm white, with a scattering of real city blocks filled in primary colors. In the Lab tab; it takes over the theme colors while it's on.

## Screenshots

<div align="center">
  <img src="docs/wallpaper.png" alt="Example wallpaper" />
</div>

## Data sources & licenses

- Road map data © **OpenStreetMap** contributors, licensed under the [Open Database License (ODbL)](https://opendatacommons.org/licenses/odbl/).
- City list from [**GeoNames**](https://www.geonames.org/), licensed under [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/).

These attributions are also shown in the app's **About** tab.

## Credits

- App icon and map visual design — **Jie Xu**

## Feedback

Found a bug or have an idea? [Open an issue](https://github.com/RalfZhang/ink-city/issues). For bug reports, please include your OS version and, if relevant, the city/date that triggered the problem.

## License

InkCity's own source code is released under the [MIT License](LICENSE). The data it displays is licensed separately, as described above.
