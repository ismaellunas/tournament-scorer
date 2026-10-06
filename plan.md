Here is the full spec, written so another agent can build from it without guessing. The riskiest part is the bracket engine, so it gets the most detail.

# Pickleball double-elimination tracker: build spec

## 1. Product summary

One offline HTML file, opened in Chrome on one laptop by one scorekeeper. It runs **two independent double-elimination tournaments** (Category A on Court 1, Category B on Court 2) side by side. It handles team registration, manual seeding, win/loss recording with undo, and a projector dashboard.

**Hard constraints**
- Single `.html` file, with CSS and JS inline and **no external requests** (no CDN, no Google Fonts). The venue may have no internet.
- Storage is **IndexedDB**. No localStorage.
- No scores, only the winner of each match.
- Each category has 4 to 16 teams. Teams are padded to a bracket of 4, 8 or 16 and the top seeds get byes.
- The grand final has a bracket reset: the losers-bracket champion must beat the winners-bracket champion twice.
- Any recorded result can be corrected or undone.

## 2. Data model

**Database** `pickleball-tracker`, version 1.

| Store | Key | Record |
|---|---|---|
| `categories` | `id` = `"A"` or `"B"` | `{ id, name, court, status, teams[], results{}, updatedAt }` |
| `meta` | `"event"` | `{ title, lastBackupAt, resultsSinceBackup }` |

- `status` is `"registration"` or `"live"`.
- `teams[]` holds `{ id, name, players }`. **Array order is the seed** (index 0 is seed 1). `players` is a free-text string.
- `results` maps `matchId` to `{ winnerId, at }`, where `at` is a timestamp.
- **Only seeds and results are stored. The bracket is never stored.** It is recomputed from those two on every render, which is what makes undo and corrections safe.
- Write to IndexedDB after every change and show a small "Saved" indicator.
- If IndexedDB is unavailable, fall back to in-memory state and show a persistent red banner: "Not saving. Data will be lost on refresh."

## 3. Bracket engine

Build this as a pure function with no DOM access: `computeBracket(teams, results)` returns the full match state. It must be testable in Node.

### 3.1 Sizing and seeding

- T is the number of teams (4 to 16). N is the smallest of 4, 8 or 16 that is at least T. Let k = log2(N).
- Seed order: start with `[1,2]`. While its length is less than N, replace each x with `[x, 2·len+1−x]`, where `len` is the length before expanding.
  - N=4 gives `[1,4,2,3]`
  - N=8 gives `[1,8,4,5,2,7,3,6]`
  - N=16 gives `[1,16,8,9,4,13,5,12,2,15,7,10,3,14,6,11]`
- Winners round 1, match i is seed `order[2i]` versus seed `order[2i+1]`.
- **Any seed number greater than T is a BYE.**

### 3.2 Match graph (static, depends only on N)

Each match has two slots. A slot's source is `seed(n)`, `winnerOf(matchId)` or `loserOf(matchId)`. Indexes below are 0-based.

**Winners bracket**, rounds W1 to Wk. Round r has N/2^r matches.
- W1: seeds as above.
- Wr match i: A = winnerOf(W(r−1), 2i), B = winnerOf(W(r−1), 2i+1).

**Losers bracket**, rounds L1 to L(2k−2). Round r has N / 2^(ceil(r/2)+1) matches.
- L1 match i: A = loserOf(W1, 2i), B = loserOf(W1, 2i+1).
- **Even rounds** L(2j), for j = 1 to k−1: A = winnerOf(L(2j−1), i). B = loserOf(W(j+1), d), where d = (count−1−i) if j is odd (reversed, to avoid immediate rematches) and d = i if j is even.
- **Odd rounds** L(2j+1), for j = 1 to k−2: A = winnerOf(L(2j), 2i), B = winnerOf(L(2j), 2i+1).

**Grand final**
- GF1: A = winnerOf(Wk, 0), B = winnerOf(L(2k−2), 0).
- GF2 (reset): same sides. It is **only played if B (the losers-bracket champion) wins GF1**.

**Reference for verification, N=8:**

| Match | Teams |
|---|---|
| W1-1, W1-2, W1-3, W1-4 | 1v8, 4v5, 2v7, 3v6 |
| W2-1, W2-2 | W(W1-1)vW(W1-2), W(W1-3)vW(W1-4) |
| W3-1 | W(W2-1)vW(W2-2) |
| L1-1, L1-2 | L(W1-1)vL(W1-2), L(W1-3)vL(W1-4) |
| L2-1, L2-2 | W(L1-1)vL(W2-2), W(L1-2)vL(W2-1) |
| L3-1 | W(L2-1)vW(L2-2) |
| L4-1 | W(L3-1)vL(W3-1) |
| GF1, GF2 | W(W3-1)vW(L4-1) |

### 3.3 Slot resolution (the part most likely to go wrong)

Every slot resolves to exactly one of three values: a **team**, **BYE**, or **PENDING** (not yet known).

For a match with resolved sides a and b:

| Case | Winner | Loser | Notes |
|---|---|---|---|
| a and b both BYE | BYE | BYE | |
| one side BYE, other is team X or PENDING | that other side's value | BYE | This is a "bye match": auto-resolved, never shown as playable, never numbered. |
| both are teams, result recorded | result's winner | the other team | |
| both are teams, no result | PENDING | PENDING | This match is **playable**. |
| either side PENDING (and no BYE) | PENDING | PENDING | Not yet playable. |

BYE-ness depends only on seeds, never on results. Resolve with memoization and recurse through `winnerOf`/`loserOf`.

**GF2:** if GF1 has no result, GF2 is "if needed" (pending). If GF1's winner is the winners-bracket champion, GF2 is **skipped**. If GF1's winner is the losers-bracket champion, GF2 is playable.

### 3.4 Match numbering

Number only real matches (non-bye), starting at 1 per category, in this round order:
W1, L1, then for r = 2 to k: Wr, L(2r−2), and L(2r−1) only if r ≤ k−1. Then GF1, GF2.

- N=8 order: W1, L1, W2, L2, L3, W3, L4, GF1, GF2.
- N=16 order: W1, L1, W2, L2, L3, W3, L4, L5, W4, L6, GF1, GF2.

### 3.5 Queue

- **Playable matches** are real matches with both teams known and no result, sorted by match number.
- The first one is **"Now playing"** and the next three are **"Up next"**.
- Also show **"Coming up"**: real matches with one team known, labelled like "Team X vs Winner of #12". Use "Winner of #n" or "Loser of #n" for unresolved slots.

### 3.6 Results, undo and corrections

- **Record:** choose a winner for a playable match.
- **Change winner:** flip an existing result.
- **Clear / undo:** remove a result. "Undo last" removes the result with the latest `at`.
- After any change, **prune** repeatedly until stable. Delete any result where the match is no longer playable-or-decided, its two teams are no longer both known, or its winner is not one of its two current teams. This cascades downstream and also clears GF2 if it becomes skipped.
- **Before applying a change that would prune other results, show a confirmation dialog listing the matches that will be cleared.** Do nothing if the user cancels.

### 3.7 Placings

- 1st and 2nd come from the final: if GF2 is played, its winner is 1st. Otherwise the GF1 winner is 1st. The other finalist is 2nd.
- 3rd is the loser of L(2k−2). 4th is the loser of L(2k−3).
- Remaining teams are grouped by the **losers-bracket round in which they were eliminated**, latest round first. Ties display as a range, for example "5th–6th".
- Per-team status labels are: *In winners bracket*, *In losers bracket*, *Eliminated (place)*, *Champion*.

### 3.8 Engine acceptance tests (run in Node)

Total real matches must equal **2T−2** with no reset, and **2T−1** with a reset. Every real match produces exactly one loss, and every team except the champion loses twice.

Test T = 4, 5, 6, 8, 11, 13, 16. Simulate every match with random winners, over at least 200 random runs per size, and check:
1. The match count is correct.
2. The champion always exists.
3. No team ever appears twice in one match.
4. No team plays after its second loss.
5. Every team gets a unique or tied placing.
6. Force the losers-bracket champion to win GF1 (GF2 appears) and the winners-bracket champion to win GF1 (GF2 is skipped).
7. Record results, change an early winner, and confirm downstream results are pruned and the bracket is still valid.

## 4. Screens

**Top bar:** event title (editable), tabs *Setup · Score · Dashboard*, a "Saved" indicator, and a *Backup* menu.

### 4.1 Setup
Two panels, one per category. Each has:
- Editable category name (default "Category A / B") and court label (default "Court 1 / 2").
- Team list. Each row has seed number, team name, players, ↑ and ↓ buttons to change seed, and delete. An "Add team" row sits below.
- A counter ("7 teams, need 4 to 16").
- **Start tournament** button. It is disabled unless there are 4 to 16 teams, no blank names, and no duplicate names (case-insensitive, trimmed). Each category starts independently.
- After start, adding, removing and reordering are locked. Name and player text stay editable (typo fixes).
- **Reset category** returns it to registration and clears results, behind a confirmation dialog.

### 4.2 Score
- Two columns, one per court, stacked on narrow screens.
- Each column has a **Now playing** card with two large team buttons. Tapping one opens a confirm dialog ("Team X wins Match 7?") before saving, to prevent mis-taps at the table.
- Below that are **Up next** and **Coming up**, then a **Results** list. Each result row has *Change winner* and *Clear*. There is also an **Undo last** button.
- A champion banner appears when the category finishes.
- Show a progress count like "Match 7 of 14".

### 4.3 Dashboard (projector)
Designed for a 1920×1080 display. Body text must stay readable from the back of a gym, so use large type sized with `vw`/`clamp`.

| View | Contents |
|---|---|
| **Courts** | Both categories side by side: Now playing (large), Up next (3), progress, and a champion banner when done |
| **Bracket** | Category selector A/B. Winners bracket on top and losers bracket below, as columns of match cards. Each card has a match number, two teams, and the winner highlighted. Bye matches are hidden or shown muted. |
| **Standings** | Both categories: alive in winners, alive in losers, eliminated with place, and a podium (1st to 4th) when complete |

- An **Auto-rotate** toggle cycles the three views every 20 seconds.
- A **Fullscreen** button hides all controls.
- The dashboard is **read-only**.

**Projector set-up assumption:** the dashboard runs in its own window on the projector (extended display), opened by an *Open projector window* button (`window.open` of the same file with `#dashboard`). The scorekeeper's window is the only writer. The dashboard window **polls IndexedDB every 1.5 seconds** and re-renders when `updatedAt` changes. Do not rely on BroadcastChannel or the `storage` event, because these are unreliable on `file://`. If the projector just mirrors the laptop screen, the Dashboard tab still works, but the scorekeeper can't use the Score tab at the same time.

## 5. Backup and recovery

- **Export** downloads a JSON file with everything. **Import** restores it, behind a confirmation dialog, then reloads state.
- Show a nudge banner after every 5 new results since the last backup: "Download a backup."
- Setup shows a note: "Always open this file from the same location. Moving or copying it creates an empty database."

## 6. Visual direction

Superseded from the original pickleball-scoreboard palette: this tool is hosted as a linked "ministry tool" under the GEWCI Ministry Tools site, so it now matches that host site's design system (`gewci-document-reviewer/src/app/globals.css` and `src/components/gewci/*`) rather than its own invented look.

- **Subject:** pickleball tournament scoreboard, used by an organizer and read by players from a distance - but skinned as a GEWCI ministry tool, not a standalone sports app.
- **Palette** (same custom-property names as before, values now sourced from GEWCI's `@theme` block):
  - `--line-white` → GEWCI white `#FEFEFE` (background)
  - `--graphite` → GEWCI dark `#0A193C` (text/foreground)
  - `--court-blue` → GEWCI navy `#1E3461` (primary - buttons, match cards, header accent)
  - `--kitchen-green` → GEWCI success `#10B981` (winners and alive)
  - `--ball-yellow` → GEWCI gold `#DBB64B` (now playing, secondary buttons, highlight)
  - `--loss-red` → GEWCI error `#EF4444` (eliminated, danger)
  - Also carries GEWCI's `--warning` (`#F59E0B`, used for "alive in losers bracket") and `--info` (`#3B82F6`, unused so far).
- **Type:** Inter (body) and Outfit (headings/display), the exact Google Fonts the host site self-hosts via `next/font`. Embedded as base64 `@font-face` data URIs (`src/fonts.css` + `src/fonts/*.b64.txt`, built from the host site's own cached `.next` build output) so the single file still makes zero network requests while matching the host site's typography byte-for-byte. Falls back to `system-ui` if a font somehow fails to parse. Tabular numerals for match numbers.
- **Component language:** mirrors GEWCI's Button (primary/secondary/outline/ghost/danger), Card (`--radius-card: 12px`, navy-tinted `--shadow-card`), and Badge (pill-shaped, `/10` tint background, `/20`-ish tint border, solid text) conventions. Buttons use `--radius-button: 8px`.
- **Header:** white top bar with a 6px navy accent strip (`.topbar-accent`) above the nav row, matching GEWCI's `<div class="h-1.5 bg-primary">` header treatment - not the original dark graphite bar.
- **Motif:** match cards keep their navy-with-white-text court-card feel; "now playing" uses the gold highlight. Avoid decorative gradients and scattered animation.
- **Quality floor:** visible keyboard focus (gold focus ring), text contrast of at least 4.5:1, never color alone to show win or loss (also use a label or icon), and `prefers-reduced-motion` respected.

## 7. Non-goals for v1

Scores, player accounts, multi-device syncing, phone access, per-team contact details, round-robin or pool play, and printing (the projector is the display).

## 8. Build order for the coding agent

1. Engine plus Node tests (section 3.8) before any UI.
2. IndexedDB layer plus fallback.
3. Setup screen.
4. Score screen, with confirm, undo and prune warning.
5. Dashboard views plus the projector window and polling.
6. Backup, import and export.
7. Dry runs with fake data at T = 4, 5, 11 and 16 in both categories at once.

Two things are not yet confirmed: the minimum of 4 teams (I assumed you meant per category), and the projector set-up described in section 4.3. If either is wrong, tell me and I'll adjust. I can also put this spec into a downloadable file for handing to the other agent, if you'd like.

## 9. Resolved decisions (addendum)

These close gaps found in review. They amend the sections above and take precedence over anything they conflict with.

- **§2 matchId format:** literal phase-round-index notation, used as-is for the `results{}` keys: `"W1-1"`, `"L2-3"`, `"GF1"`, `"GF2"` (1-indexed round, 1-indexed match within round).
- **§2 team.id:** incrementing integer, scoped per category (1, 2, 3…), assigned when a team is added.
- **§2 category status:** stays exactly `"registration"` / `"live"` as specified — no third stored `"complete"` value. "Finished" is always derived at render time by checking whether `computeBracket` assigned a champion.
- **§4.1 duplicate names:** case-insensitive/trimmed uniqueness is checked **within a category only**; the same team name may appear in both A and B.
- **§3.5 "Coming up":** capped at the next 5 real matches (by match number) with exactly one team known.
- **§3.6 "Undo last":** goes through the same cascade-prune confirmation dialog as any other correction — it is not guaranteed cascade-free, since an earlier match's result can carry the latest timestamp if it was corrected after later matches were recorded.
- **§3.3 BYE+PENDING case:** confirmed as read — a match with one BYE slot and one PENDING slot is still auto-resolved (never numbered, never shown as playable), but its winner value remains PENDING and keeps propagating upstream until the other branch resolves.
- **§4.1 "Reset category":** clears only `results{}` and reverts `status` to `"registration"`. The team roster and seed order are preserved, not wiped, and become editable/reorderable again.
- **§4.1 16-team cap:** the "Add team" control is disabled once a category reaches 16 teams; the counter reads "16 teams, max reached".
- **§4.2/§4.3 pre-start state:** a category still in `"registration"` shows an explicit placeholder ("Category B — registration not started") in place of Now playing / bracket / standings content, on both Score and Dashboard, rather than being hidden entirely.
- **§4.3 Auto-rotate + Bracket view:** each time auto-rotate lands on the Bracket view, it alternates which category (A/B) is shown, so an unattended projector eventually cycles both.
- **§4.3 Fullscreen:** implemented with the standard Fullscreen API (`requestFullscreen` / native Esc-to-exit), not a custom hide/reveal overlay.
- **§5 resultsSinceBackup:** one combined counter across both categories (per the existing single `meta/event` record); increments on any new result in either category, resets to 0 on Export.
- **§5 Import:** validates the JSON's top-level shape (expects `categories.A`, `categories.B`, `meta`) before writing to IndexedDB; shows an error and aborts on mismatch rather than loading an unknown shape.
- **§1/§4.1 minimum teams:** confirmed per category — each of A and B independently needs 4–16 teams before it can start.
- **§4.3 projector risk:** before building the dashboard window/polling, spike-test that two `window.open` instances of the same `file://` document share one IndexedDB (write from one, confirm the poll reads it in the other). Proceed with the spec'd dual-window design once confirmed; if it fails, fall back to "projector mirrors the laptop screen, Dashboard tab only" per §4.3's existing fallback note.