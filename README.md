# Laptop QoL

Small quality-of-life tweaks for using Obsidian on a laptop. Each tweak is a separate module: turn on only what you use. Modules toggle instantly in **Settings → Laptop QoL**, no restart needed.

Desktop only.

## Modules

### Swipe Nav

Swipe with two fingers on the touchpad to go back and forward between notes, like in a browser.

- Swipe right to go back, left to go forward (Safari-style slide: the current note slides away and reveals the previous one, with a live preview of the target note).
- Release past a threshold, or flick, to navigate; otherwise the note snaps back.
- At the end of history the note resists and bounces back.
- Vertical scrolling, wide tables and code blocks that scroll horizontally, and views with their own panning (Graph, Canvas, Excalidraw) are left alone.
- With an E-Ink theme active (theme name starting with "E-Ink"), the animation is skipped and the swipe switches notes instantly.

Settings:

- **Invert direction**: turn on if swiping right goes forward instead of back.
- **Swipe distance**: how far you need to swipe (default 600). Higher = longer swipe.

Note: needs a touchpad (or any device that sends horizontal scroll events). A mouse wheel does nothing.

### Graph: zoom out at cursor

In Graph view (global and local), zooming in already anchors at the cursor, but zooming out anchors at the screen center. This module makes zoom out anchor at the cursor too.

It also adds a checked **Zoom out at cursor** item to the graph view's "More options" (⋯) menu; clicking it turns the module off.

## Installation

From Obsidian: **Settings → Community plugins → Browse**, search for "Laptop QoL".

Manual: download `main.js`, `manifest.json` and `styles.css` from the [latest release](https://github.com/matteoandradeboschi/obsidian-laptop-qol/releases/latest) into `<vault>/.obsidian/plugins/laptop-qol/`, then enable the plugin.

## Compatibility notes

Some modules hook into undocumented Obsidian internals (graph renderer zoom, navigation history, the properties widget renderer). A future Obsidian update may break a module; if that happens, turn that module off and open an issue.

The plugin makes no network requests and collects no data.

## Releasing (maintainer notes)

1. Bump `version` in `manifest.json` and add `"<version>": "<minAppVersion>"` to `versions.json`.
2. Commit, then tag with the exact version (no `v` prefix) and push the tag:

   ```bash
   git tag 0.2.0 && git push origin 0.2.0
   ```

3. The GitHub Action creates the release with `main.js`, `manifest.json` and `styles.css`.

## License

[MIT](LICENSE)
