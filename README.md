# Pickleball Tournament Tracker

A single offline HTML file for running two simultaneous double-elimination
pickleball tournaments (Category A / Court 1 and Category B / Court 2) from
one laptop. No internet connection or server required.

See [plan.md](plan.md) for the full build spec.

## Features

- Two independent double-elimination brackets, 4-16 teams each, run side by side
- Manual seeding with automatic byes for brackets of 4, 8, or 16
- Grand final with bracket reset (losers-bracket champion must win twice)
- Win/loss recording with undo and correction of any result
- Projector-friendly dashboard view
- Data persisted locally in IndexedDB (falls back to in-memory with a warning banner if unavailable)
- Everything - HTML, CSS, JS, fonts - bundled into one file with no external requests
- Installable as a Chrome app (PWA) via `manifest.json` and `icons/`

## Usage

Open `index.html` in a browser. That's it - no install, no server.

When served over HTTPS (e.g. the Vercel deployment), Chrome's address bar
offers an "Install" option that adds it as a standalone app with no browser
chrome. `manifest.json` and `icons/` are the only files outside `index.html`
needed for this; they're static and don't go through `build.js`.

## Development

Source files live in `src/`:

- `src/engine.js` - pure bracket engine (seeding, match graph, slot resolution)
- `src/db.js` - IndexedDB storage layer with in-memory fallback
- `src/app.js` - UI and application logic
- `src/template.html`, `src/styles.css`, `src/fonts.css` - page shell, styles, and inlined fonts

`index.html` is a generated build artifact. After changing anything in `src/`, rebuild it:

```
node build.js
```

### Tests

The bracket engine is covered by randomized simulation tests using Node's
built-in test runner:

```
node --test test/
```
