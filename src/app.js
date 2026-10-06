(function () {
  'use strict';

  const Engine = window.Engine;
  const store = window.DBStore.createStore();

  const state = {
    meta: null,
    categories: { A: null, B: null },
    dbMode: 'indexeddb',
    activeTab: 'setup',
    standalone: false,
    nudgeDismissed: false,
    dashboard: { view: 'courts', autoRotate: false, bracketCategory: 'A' },
  };

  // ---------------------------------------------------------------- utils

  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }

  function teamName(cat, teamId) {
    const t = cat.teams.find((x) => x.id === teamId);
    return t ? (t.name.trim() || `(unnamed seed ${cat.teams.indexOf(t) + 1})`) : '—';
  }

  // Resolves a slot that's still PENDING into a "Winner of #N" / "Loser of
  // #N" label, walking past any unnumbered bye matches in between.
  function describeSlot(cat, bracket, resolvedValue, slotDef) {
    if (resolvedValue.kind === 'team') return escapeHtml(teamName(cat, resolvedValue.teamId));
    if (resolvedValue.kind === 'bye') return 'BYE';
    let def = slotDef;
    for (let i = 0; i < 20 && def; i++) {
      const src = bracket.matches[def.id];
      if (!src) return 'TBD';
      if (src.number != null) {
        return (def.type === 'winnerOf' ? 'Winner of #' : 'Loser of #') + src.number;
      }
      if (def.type !== 'winnerOf') return 'TBD';
      if (src.slotA.kind === 'pending') def = src.def.slotA;
      else if (src.slotB.kind === 'pending') def = src.def.slotB;
      else return 'TBD';
    }
    return 'TBD';
  }

  function withFocusPreserved(fn) {
    const active = document.activeElement;
    const id = active && active.id;
    const selStart = active && 'selectionStart' in active ? active.selectionStart : null;
    const selEnd = active && 'selectionEnd' in active ? active.selectionEnd : null;
    fn();
    if (id) {
      const el = document.getElementById(id);
      if (el) {
        el.focus();
        if (selStart != null && el.setSelectionRange) {
          try { el.setSelectionRange(selStart, selEnd); } catch (e) { /* not a text-range input */ }
        }
      }
    }
  }

  // ---------------------------------------------------------------- persistence

  function setSavedState(s) {
    const el = document.getElementById('saved-indicator');
    if (!el) return;
    el.dataset.state = s;
    el.textContent = s === 'saving' ? 'Saving…' : 'Saved';
  }

  function updateDangerBanner() {
    const el = document.getElementById('danger-banner');
    if (el) el.hidden = state.dbMode !== 'memory';
  }

  async function saveCategory(catId) {
    setSavedState('saving');
    const durable = await store.putCategory(state.categories[catId]);
    if (!durable) state.dbMode = 'memory';
    updateDangerBanner();
    setSavedState('saved');
  }

  async function saveMeta() {
    setSavedState('saving');
    const durable = await store.putMeta(state.meta);
    if (!durable) state.dbMode = 'memory';
    updateDangerBanner();
    setSavedState('saved');
  }

  async function bumpResultsSinceBackup() {
    state.meta.resultsSinceBackup = (state.meta.resultsSinceBackup || 0) + 1;
    state.nudgeDismissed = false;
    await saveMeta();
  }

  // ---------------------------------------------------------------- setup actions

  function nextTeamId(cat) {
    let max = 0;
    for (const t of cat.teams) if (t.id > max) max = t.id;
    return max + 1;
  }

  async function addTeam(catId) {
    const cat = state.categories[catId];
    if (cat.status !== 'registration' || cat.teams.length >= 16) return;
    cat.teams.push({ id: nextTeamId(cat), name: '', players: '' });
    await saveCategory(catId);
    renderActive();
  }

  async function deleteTeam(catId, teamId) {
    const cat = state.categories[catId];
    if (cat.status !== 'registration') return;
    cat.teams = cat.teams.filter((t) => t.id !== teamId);
    await saveCategory(catId);
    renderActive();
  }

  async function moveTeam(catId, teamId, dir) {
    const cat = state.categories[catId];
    if (cat.status !== 'registration') return;
    const idx = cat.teams.findIndex((t) => t.id === teamId);
    const swapIdx = idx + dir;
    if (idx < 0 || swapIdx < 0 || swapIdx >= cat.teams.length) return;
    const tmp = cat.teams[idx];
    cat.teams[idx] = cat.teams[swapIdx];
    cat.teams[swapIdx] = tmp;
    await saveCategory(catId);
    renderActive();
  }

  function updateTeamFieldSync(catId, teamId, field, value) {
    const cat = state.categories[catId];
    const team = cat.teams.find((t) => t.id === teamId);
    if (team) team[field] = value;
  }

  function validateStart(cat) {
    const errors = [];
    if (cat.teams.length < 4 || cat.teams.length > 16) errors.push('need 4 to 16 teams');
    const names = cat.teams.map((t) => t.name.trim());
    if (names.some((n) => n === '')) errors.push('no blank names');
    const lower = names.map((n) => n.toLowerCase());
    if (new Set(lower).size !== lower.length) errors.push('no duplicate names');
    return errors;
  }

  async function startTournament(catId) {
    const cat = state.categories[catId];
    if (cat.status !== 'registration' || validateStart(cat).length > 0) return;
    cat.status = 'live';
    await saveCategory(catId);
    renderActive();
  }

  async function resetCategory(catId) {
    const cat = state.categories[catId];
    if (!confirm(`Reset ${cat.name}? This clears all results. Teams and seeding are kept.`)) return;
    cat.status = 'registration';
    cat.results = {};
    await saveCategory(catId);
    renderActive();
  }

  // ---------------------------------------------------------------- score actions

  async function handleRecordResult(catId, matchId, winnerId) {
    const cat = state.categories[catId];
    const bracket = Engine.computeBracket(cat.teams, cat.results);
    const m = bracket.matches[matchId];
    if (!m || m.winner.kind !== 'pending') return;
    const label = teamName(cat, winnerId);
    if (!confirm(`${label} wins Match ${m.number}?`)) return;
    const isNew = !(matchId in cat.results);
    cat.results = Engine.setResult(cat.teams, cat.results, matchId, winnerId, Date.now());
    if (isNew) await bumpResultsSinceBackup();
    await saveCategory(catId);
    renderActive();
  }

  async function applyResultChange(catId, nextResults) {
    const cat = state.categories[catId];
    const { prunedResults, removedIds } = Engine.diffPrune(cat.teams, cat.results, nextResults);
    if (removedIds.length > 0) {
      const beforeBracket = Engine.computeBracket(cat.teams, cat.results);
      const afterAttemptBracket = Engine.computeBracket(cat.teams, nextResults);
      const labels = removedIds.map((id) => {
        const m = beforeBracket.matches[id] || afterAttemptBracket.matches[id];
        return m && m.number != null ? `Match #${m.number}` : id;
      });
      if (!confirm(`This will also clear: ${labels.join(', ')}. Continue?`)) return false;
    }
    cat.results = prunedResults;
    await saveCategory(catId);
    return true;
  }

  async function handleChangeWinner(catId, matchId) {
    const cat = state.categories[catId];
    const bracket = Engine.computeBracket(cat.teams, cat.results);
    const m = bracket.matches[matchId];
    const current = cat.results[matchId];
    if (!current) return;
    const other = current.winnerId === m.slotA.teamId ? m.slotB.teamId : m.slotA.teamId;
    const next = Engine.setResult(cat.teams, cat.results, matchId, other, Date.now());
    if (await applyResultChange(catId, next)) renderActive();
  }

  async function handleClearResult(catId, matchId) {
    const cat = state.categories[catId];
    const next = Engine.clearResult(cat.results, matchId);
    if (await applyResultChange(catId, next)) renderActive();
  }

  async function handleUndoLast(catId) {
    const cat = state.categories[catId];
    const lastId = Engine.findLastResultId(cat.results);
    if (!lastId) return;
    const next = Engine.clearResult(cat.results, lastId);
    if (await applyResultChange(catId, next)) renderActive();
  }

  // ---------------------------------------------------------------- backup

  async function handleExport() {
    const data = await store.exportAll();
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    a.href = url;
    a.download = `pickleball-backup-${stamp}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    state.meta.resultsSinceBackup = 0;
    state.meta.lastBackupAt = Date.now();
    state.nudgeDismissed = false;
    await saveMeta();
    renderActive();
  }

  function triggerImport() {
    document.getElementById('import-file-input').click();
  }

  async function handleImportFile(file) {
    const text = await file.text();
    let data;
    try { data = JSON.parse(text); } catch (e) { alert('That file is not valid JSON.'); return; }
    if (!confirm('Import this backup? This replaces all current data in both categories.')) return;
    try {
      await store.importAll(data);
    } catch (e) {
      alert('Could not import: ' + e.message);
      return;
    }
    location.reload();
  }

  // ---------------------------------------------------------------- setup view

  function renderSetup() {
    return `<div class="setup-grid">${renderCategoryPanel('A')}${renderCategoryPanel('B')}</div>`;
  }

  function renderCategoryPanel(catId) {
    const cat = state.categories[catId];
    const locked = cat.status !== 'registration';
    const errors = validateStart(cat);
    const canStart = errors.length === 0 && !locked;

    let html = `<div class="category-panel" data-cat="${catId}">
      <div class="panel-head">
        <input type="text" id="cat-name-${catId}" data-bind="cat-name" data-cat="${catId}" value="${escapeHtml(cat.name)}" aria-label="Category name">
        <input type="text" id="cat-court-${catId}" data-bind="cat-court" data-cat="${catId}" value="${escapeHtml(cat.court)}" aria-label="Court label">
      </div>`;

    html += `<table class="team-table"><thead><tr><th>Seed</th><th>Team name</th><th>Players</th>${locked ? '' : '<th></th><th></th>'}</tr></thead><tbody>`;
    cat.teams.forEach((team, idx) => {
      html += `<tr>
        <td class="seed-num tabular-nums">${idx + 1}</td>
        <td><input type="text" id="team-name-${catId}-${team.id}" data-bind="team-name" data-cat="${catId}" data-team="${team.id}" value="${escapeHtml(team.name)}" placeholder="Team name"></td>
        <td><input type="text" id="team-players-${catId}-${team.id}" data-bind="team-players" data-cat="${catId}" data-team="${team.id}" value="${escapeHtml(team.players)}" placeholder="Players"></td>`;
      if (!locked) {
        html += `<td class="team-row-actions">
          <button type="button" class="btn-small btn-ghost" data-action="move-team" data-cat="${catId}" data-team="${team.id}" data-dir="-1" ${idx === 0 ? 'disabled' : ''} aria-label="Move up in seeding">↑</button>
          <button type="button" class="btn-small btn-ghost" data-action="move-team" data-cat="${catId}" data-team="${team.id}" data-dir="1" ${idx === cat.teams.length - 1 ? 'disabled' : ''} aria-label="Move down in seeding">↓</button>
        </td>
        <td><button type="button" class="btn-small btn-danger" data-action="delete-team" data-cat="${catId}" data-team="${team.id}">Delete</button></td>`;
      }
      html += `</tr>`;
    });
    html += `</tbody></table>`;

    if (!locked) {
      html += `<div class="panel-actions" style="margin-bottom:0.8rem;">
        <button type="button" class="btn-secondary btn-small" data-action="add-team" data-cat="${catId}" ${cat.teams.length >= 16 ? 'disabled' : ''}>+ Add team</button>
      </div>`;
    }

    const countOk = cat.teams.length >= 4 && cat.teams.length <= 16;
    html += `<div class="counter-line ${countOk ? 'ok' : ''}">${cat.teams.length} team${cat.teams.length === 1 ? '' : 's'}, need 4 to 16${cat.teams.length >= 16 ? ' (max reached)' : ''}</div>`;

    html += `<div class="panel-actions">`;
    if (!locked) {
      html += `<button type="button" data-action="start-tournament" data-cat="${catId}" ${canStart ? '' : 'disabled'}>Start tournament</button>`;
      if (errors.length) html += `<span class="locked-note">${escapeHtml(errors.join(', '))}</span>`;
    } else {
      html += `<span class="locked-note">Tournament started — roster locked. Names stay editable.</span>
        <button type="button" class="btn-danger btn-small" data-action="reset-category" data-cat="${catId}">Reset category</button>`;
    }
    html += `</div>`;
    html += `<p class="locked-note">Always open this file from the same location. Moving or copying it creates an empty database.</p>`;
    html += `</div>`;
    return html;
  }

  // ---------------------------------------------------------------- score view

  function renderScoreColumn(catId) {
    const cat = state.categories[catId];
    if (cat.status !== 'live') {
      return `<div class="court-column"><h2>${escapeHtml(cat.name)} <span class="court-label">${escapeHtml(cat.court)}</span></h2>
        <div class="placeholder-box">${escapeHtml(cat.name)} — registration not started</div></div>`;
    }

    const bracket = Engine.computeBracket(cat.teams, cat.results);
    const decided = bracket.order.filter((id) => !bracket.matches[id].isBye && bracket.matches[id].winner.kind === 'team').length;

    let html = `<div class="court-column"><h2>${escapeHtml(cat.name)} <span class="court-label">${escapeHtml(cat.court)}</span></h2>`;

    if (bracket.champion) {
      html += `<div class="champion-banner">🏆 Champion: ${escapeHtml(teamName(cat, bracket.champion))}</div>`;
    } else {
      html += `<div class="progress-line tabular-nums">Match ${decided + 1} of ${bracket.totalReal}</div>`;
    }

    if (bracket.nowPlaying) {
      const m = bracket.nowPlaying;
      html += `<div class="match-card now-playing">
        <div class="match-number tabular-nums">Now playing — Match #${m.number}</div>
        <div class="match-sides">
          <button type="button" class="team-btn" data-action="record-result" data-cat="${catId}" data-match="${m.id}" data-winner="${m.slotA.teamId}">${escapeHtml(teamName(cat, m.slotA.teamId))}</button>
          <div class="side-line"></div>
          <button type="button" class="team-btn" data-action="record-result" data-cat="${catId}" data-match="${m.id}" data-winner="${m.slotB.teamId}">${escapeHtml(teamName(cat, m.slotB.teamId))}</button>
        </div>
      </div>`;
    } else if (!bracket.champion) {
      html += `<div class="placeholder-box">Waiting on earlier matches</div>`;
    }

    if (bracket.upNext.length) {
      html += `<h3>Up next</h3><ul class="mini-match-list">` +
        bracket.upNext.map((m) => `<li><span class="mnum tabular-nums">#${m.number}</span><span>${escapeHtml(teamName(cat, m.slotA.teamId))} vs ${escapeHtml(teamName(cat, m.slotB.teamId))}</span></li>`).join('') +
        `</ul>`;
    }

    if (bracket.comingUp.length) {
      html += `<h3>Coming up</h3><ul class="mini-match-list">` +
        bracket.comingUp.map((m) => `<li><span class="mnum tabular-nums">#${m.number}</span><span>${describeSlot(cat, bracket, m.slotA, m.def.slotA)} vs ${describeSlot(cat, bracket, m.slotB, m.def.slotB)}</span></li>`).join('') +
        `</ul>`;
    }

    html += `<div class="panel-actions" style="margin: 0.6rem 0 1rem;">
      <button type="button" class="btn-secondary btn-small" data-action="undo-last" data-cat="${catId}" ${Object.keys(cat.results).length === 0 ? 'disabled' : ''}>Undo last</button>
    </div>`;

    const resultRows = bracket.order
      .filter((id) => !bracket.matches[id].isBye && bracket.matches[id].winner.kind === 'team')
      .map((id) => bracket.matches[id])
      .sort((a, b) => cat.results[b.id].at - cat.results[a.id].at);

    html += `<h3>Results</h3><ul class="results-list">` +
      (resultRows.length === 0 ? '<li>No results yet</li>' : resultRows.map((m) => `<li>
        <span class="tabular-nums">#${m.number}</span>
        <span>${escapeHtml(teamName(cat, m.slotA.teamId))} vs ${escapeHtml(teamName(cat, m.slotB.teamId))}</span>
        <span class="win-tag">${escapeHtml(teamName(cat, m.winner.teamId))}</span>
        <span class="result-actions">
          <button type="button" class="btn-small btn-ghost" data-action="change-winner" data-cat="${catId}" data-match="${m.id}">Change winner</button>
          <button type="button" class="btn-small btn-danger" data-action="clear-result" data-cat="${catId}" data-match="${m.id}">Clear</button>
        </span>
      </li>`).join('')) +
      `</ul>`;

    html += `</div>`;
    return html;
  }

  // ---------------------------------------------------------------- dashboard view

  function renderDashboard(container, opts) {
    const standalone = !!opts.standalone;
    const d = state.dashboard;
    let controls = `<div class="dash-controls">
      <div class="cat-select">
        <button type="button" class="btn-small ${d.view === 'courts' ? '' : 'btn-ghost'}" data-action="dash-view" data-view="courts">Courts</button>
        <button type="button" class="btn-small ${d.view === 'bracket' ? '' : 'btn-ghost'}" data-action="dash-view" data-view="bracket">Bracket</button>
        <button type="button" class="btn-small ${d.view === 'standings' ? '' : 'btn-ghost'}" data-action="dash-view" data-view="standings">Standings</button>
      </div>`;
    if (d.view === 'bracket') {
      controls += `<div class="cat-select">
        <button type="button" class="btn-small ${d.bracketCategory === 'A' ? '' : 'btn-ghost'}" data-action="dash-bracket-cat" data-cat="A">A</button>
        <button type="button" class="btn-small ${d.bracketCategory === 'B' ? '' : 'btn-ghost'}" data-action="dash-bracket-cat" data-cat="B">B</button>
      </div>`;
    }
    const isFullscreen = !!document.fullscreenElement;
    controls += `<button type="button" class="btn-small ${d.autoRotate ? '' : 'btn-ghost'}" data-action="dash-toggle-rotate">Auto-rotate</button>
      <button type="button" class="btn-small btn-ghost" data-action="dash-fullscreen">${isFullscreen ? 'Exit fullscreen' : 'Fullscreen'}</button>`;
    controls += `</div>`;

    let body = '<div class="dash-body">';
    if (d.view === 'courts') body += renderDashCourts();
    else if (d.view === 'bracket') body += renderDashBracket(d.bracketCategory);
    else body += renderDashStandings();
    body += '</div>';

    container.innerHTML = `<div class="dash-shell ${standalone ? 'standalone' : ''}">${controls}${body}</div>`;
  }

  function renderDashCourts() {
    return `<div class="dash-courts">` + ['A', 'B'].map((catId) => {
      const cat = state.categories[catId];
      if (cat.status !== 'live') {
        return `<div class="dash-court"><h2>${escapeHtml(cat.name)}</h2><div class="placeholder-box">${escapeHtml(cat.name)} — registration not started</div></div>`;
      }
      const bracket = Engine.computeBracket(cat.teams, cat.results);
      let html = `<div class="dash-court"><h2>${escapeHtml(cat.name)} <span class="court-label">${escapeHtml(cat.court)}</span></h2>`;
      if (bracket.champion) {
        html += `<div class="dash-now-playing"><div class="match-number">Champion</div><div class="dash-sides"><div class="dash-team">${escapeHtml(teamName(cat, bracket.champion))}</div></div></div>`;
      } else if (bracket.nowPlaying) {
        const m = bracket.nowPlaying;
        html += `<div class="dash-now-playing"><div class="match-number tabular-nums">Now playing — Match #${m.number}</div>
          <div class="dash-sides">
            <div class="dash-team">${escapeHtml(teamName(cat, m.slotA.teamId))}</div>
            <div class="dash-team">${escapeHtml(teamName(cat, m.slotB.teamId))}</div>
          </div></div>`;
      }
      const decided = bracket.order.filter((id) => !bracket.matches[id].isBye && bracket.matches[id].winner.kind === 'team').length;
      html += `<div class="progress-line tabular-nums">${bracket.champion ? 'Complete' : `Match ${decided + 1} of ${bracket.totalReal}`}</div>`;
      if (bracket.upNext.length) {
        html += `<ul class="dash-upnext-list">` + bracket.upNext.map((m) => `<li><span class="tabular-nums">#${m.number}</span> ${escapeHtml(teamName(cat, m.slotA.teamId))} vs ${escapeHtml(teamName(cat, m.slotB.teamId))}</li>`).join('') + `</ul>`;
      }
      html += `</div>`;
      return html;
    }).join('') + `</div>`;
  }

  // ---- Bracket tree layout -----------------------------------------
  //
  // Every match's vertical center is the average of the two matches that
  // feed into it (the same rule the engine's own match graph already
  // encodes via winnerOf/loserOf), recursed from the W1 base case. This
  // reproduces a standard single-elimination merge tree for the winners
  // side, and happens to work for the losers side too since L1 pairs the
  // same W1 matches W2 does, L(even) merges an L(odd) winner with a
  // dropped W loser, and L(odd>1) merges two L(even) winners - every
  // round is still just "average of two known sources." Positions are
  // computed purely from the static match graph (N, k only) - no DOM
  // measurement needed.

  const TREE_CARD_W = 190;
  const TREE_CARD_H = 52;
  const TREE_COL_GAP = 60;
  const TREE_ROW_GAP = 14;
  const TREE_GROUP_GAP = 56;

  function computeBracketLayout(N, k) {
    const graph = Engine.buildGraph(N, k);
    const totalLosersRounds = 2 * k - 2;

    const colX = {};
    for (let r = 1; r <= k; r++) colX['W' + r] = (r - 1) * (TREE_CARD_W + TREE_COL_GAP);
    for (let r = 1; r <= totalLosersRounds; r++) colX['L' + r] = (r - 1) * (TREE_CARD_W + TREE_COL_GAP);
    const gfX = Math.max(colX['W' + k], colX['L' + totalLosersRounds]) + (TREE_CARD_W + TREE_COL_GAP);

    const yCenter = {};
    const w1Count = N / 2;
    for (let i = 0; i < w1Count; i++) yCenter['W1-' + (i + 1)] = i * (TREE_CARD_H + TREE_ROW_GAP) + TREE_CARD_H / 2;
    for (let r = 2; r <= k; r++) {
      const count = N / Math.pow(2, r);
      for (let i = 0; i < count; i++) {
        const a = yCenter['W' + (r - 1) + '-' + (2 * i + 1)];
        const b = yCenter['W' + (r - 1) + '-' + (2 * i + 2)];
        yCenter['W' + r + '-' + (i + 1)] = (a + b) / 2;
      }
    }
    const winnersHeight = w1Count * (TREE_CARD_H + TREE_ROW_GAP) - TREE_ROW_GAP;

    // Even losers rounds reseed a dropped winners-bracket loser against the
    // previous losers round, using a *reversed* index to avoid an immediate
    // rematch (see engine.js buildGraph). Averaging that reversed source in
    // with its mirrored partner collapses two different matches onto the
    // same Y (e.g. L2-1/L2-4 and L2-2/L2-3 land on identical centers for
    // N=16). So for layout only, even rounds just inherit the previous
    // losers round's Y at the same index - the connector line to the
    // reseeded W match is still drawn from that W match's own position,
    // just with a longer vertical jog, which is normal for a reseed line.
    const losersIds = [];
    for (let r = 1; r <= totalLosersRounds; r++) {
      const count = N / Math.pow(2, Math.ceil(r / 2) + 1);
      for (let i = 0; i < count; i++) {
        const id = 'L' + r + '-' + (i + 1);
        if (r === 1) {
          const def = graph[id];
          yCenter[id] = (yCenter[def.slotA.id] + yCenter[def.slotB.id]) / 2;
        } else if (r % 2 === 0) {
          yCenter[id] = yCenter['L' + (r - 1) + '-' + (i + 1)];
        } else {
          const a = yCenter['L' + (r - 1) + '-' + (2 * i + 1)];
          const b = yCenter['L' + (r - 1) + '-' + (2 * i + 2)];
          yCenter[id] = (a + b) / 2;
        }
        losersIds.push(id);
      }
    }
    const minLosersY = Math.min(...losersIds.map((id) => yCenter[id]));
    const losersOffset = winnersHeight + TREE_GROUP_GAP + TREE_CARD_H / 2 - minLosersY;
    for (const id of losersIds) yCenter[id] += losersOffset;

    yCenter.GF1 = (yCenter['W' + k + '-1'] + yCenter['L' + totalLosersRounds + '-1']) / 2;
    yCenter.GF2 = yCenter.GF1 + (TREE_CARD_H + TREE_ROW_GAP) * 1.4;

    const positions = {};
    for (let r = 1; r <= k; r++) {
      const count = N / Math.pow(2, r);
      for (let i = 1; i <= count; i++) positions['W' + r + '-' + i] = { x: colX['W' + r], y: yCenter['W' + r + '-' + i] - TREE_CARD_H / 2 };
    }
    for (let r = 1; r <= totalLosersRounds; r++) {
      const count = N / Math.pow(2, Math.ceil(r / 2) + 1);
      for (let i = 1; i <= count; i++) positions['L' + r + '-' + i] = { x: colX['L' + r], y: yCenter['L' + r + '-' + i] - TREE_CARD_H / 2 };
    }
    positions.GF1 = { x: gfX, y: yCenter.GF1 - TREE_CARD_H / 2 };
    positions.GF2 = { x: gfX, y: yCenter.GF2 - TREE_CARD_H / 2 };

    const width = gfX + TREE_CARD_W;
    const height = Math.max(...Object.values(positions).map((p) => p.y)) + TREE_CARD_H;

    return { graph, positions, width, height, winnersHeight, totalLosersRounds };
  }

  function renderDashBracket(catId) {
    const cat = state.categories[catId];
    if (cat.status !== 'live') return `<div class="placeholder-box">${escapeHtml(cat.name)} — registration not started</div>`;
    const bracket = Engine.computeBracket(cat.teams, cat.results);
    const layout = computeBracketLayout(bracket.N, bracket.k);
    const M = 24;

    const cardHtml = (id) => {
      const m = bracket.matches[id];
      const pos = layout.positions[id];
      const muted = m.isBye ? ' muted' : '';
      const gfClass = id === 'GF1' || id === 'GF2' ? ' gf' : '';
      const sideHtml = (resolvedVal, def) => {
        const label = describeSlot(cat, bracket, resolvedVal, def);
        const isWinner = m.winner.kind === 'team' && resolvedVal.kind === 'team' && resolvedVal.teamId === m.winner.teamId;
        return `<div class="tree-side ${isWinner ? 'winner' : ''}">${label}</div>`;
      };
      const numberLabel = m.number != null ? `#${m.number}` : (id === 'GF2' && m.skipped ? 'Not needed' : '');
      return `<div class="tree-card${muted}${gfClass}" style="left:${pos.x + M}px; top:${pos.y + M}px; width:${TREE_CARD_W}px;">
        <div class="tree-num tabular-nums">${numberLabel}</div>
        ${sideHtml(m.slotA, m.def.slotA)}
        ${sideHtml(m.slotB, m.def.slotB)}
      </div>`;
    };

    let cards = '';
    for (let r = 1; r <= bracket.k; r++) {
      const count = bracket.N / Math.pow(2, r);
      for (let i = 1; i <= count; i++) cards += cardHtml(`W${r}-${i}`);
    }
    for (let r = 1; r <= layout.totalLosersRounds; r++) {
      const count = bracket.N / Math.pow(2, Math.ceil(r / 2) + 1);
      for (let i = 1; i <= count; i++) cards += cardHtml(`L${r}-${i}`);
    }
    cards += cardHtml('GF1');
    cards += cardHtml('GF2');

    const lines = [];
    const connect = (fromId, toId) => {
      const a = layout.positions[fromId];
      const b = layout.positions[toId];
      if (!a || !b) return;
      const x1 = a.x + M + TREE_CARD_W;
      const y1 = a.y + M + TREE_CARD_H / 2;
      const x2 = b.x + M;
      const y2 = b.y + M + TREE_CARD_H / 2;
      const midX = x1 + (x2 - x1) / 2;
      lines.push(`<path d="M${x1},${y1} H${midX} V${y2} H${x2}" class="tree-line" />`);
    };
    const connectFromDef = (id) => {
      const def = layout.graph[id];
      if (def.slotA.type !== 'seed') connect(def.slotA.id, id);
      if (def.slotB.type !== 'seed') connect(def.slotB.id, id);
    };
    for (let r = 2; r <= bracket.k; r++) {
      const count = bracket.N / Math.pow(2, r);
      for (let i = 1; i <= count; i++) connectFromDef(`W${r}-${i}`);
    }
    for (let r = 1; r <= layout.totalLosersRounds; r++) {
      const count = bracket.N / Math.pow(2, Math.ceil(r / 2) + 1);
      for (let i = 1; i <= count; i++) connectFromDef(`L${r}-${i}`);
    }
    connectFromDef('GF1');
    connect('GF1', 'GF2'); // GF2 only ever rematches GF1's two teams, so show it hanging off GF1 rather than duplicating both source lines.

    let extras = '';
    if (bracket.champion) {
      const p = bracket.placings;
      const gf2pos = layout.positions.GF2;
      extras += `<div class="tree-champion-badge" style="left:${gf2pos.x + M}px; top:${gf2pos.y + M + TREE_CARD_H + 14}px; width:${TREE_CARD_W}px;">
        <div class="tree-champ-name">🏆 ${escapeHtml(teamName(cat, p.champion))}</div>
        ${p.runnerUp ? `<div class="tree-runnerup-name">2nd — ${escapeHtml(teamName(cat, p.runnerUp))}</div>` : ''}
      </div>`;
    }

    const width = layout.width + M * 2;
    const height = layout.height + M * 2 + (bracket.champion ? 70 : 0);
    const wLabelY = layout.positions['W1-1'].y + M - 26;
    const lLabelY = layout.positions['L1-1'].y + M - 26;

    return `<h3 class="dash-bracket-section-title">${escapeHtml(cat.name)}</h3>
      <div class="bracket-tree-wrap">
        <div class="bracket-tree" style="width:${width}px; height:${height}px;">
          <div class="tree-group-label" style="left:${M}px; top:${wLabelY}px;">Winners bracket</div>
          <div class="tree-group-label" style="left:${M}px; top:${lLabelY}px;">Losers bracket</div>
          <svg class="tree-svg" width="${width}" height="${height}">${lines.join('')}</svg>
          ${cards}
          ${extras}
        </div>
      </div>`;
  }

  function renderDashStandings() {
    return `<div class="dash-standings">` + ['A', 'B'].map((catId) => {
      const cat = state.categories[catId];
      if (cat.status !== 'live') {
        return `<div><h2>${escapeHtml(cat.name)}</h2><div class="placeholder-box">${escapeHtml(cat.name)} — registration not started</div></div>`;
      }
      const bracket = Engine.computeBracket(cat.teams, cat.results);
      let html = `<div><h2>${escapeHtml(cat.name)}</h2>`;
      if (bracket.champion) {
        const p = bracket.placings;
        const podium = [[1, p.champion], [2, p.runnerUp], [3, p.third], [4, p.fourth]].filter(([, id]) => id);
        const labels = { 1: '1st', 2: '2nd', 3: '3rd', 4: '4th' };
        html += `<ol class="dash-podium">` + podium.map(([place, id]) => `<li>${labels[place]} — ${escapeHtml(teamName(cat, id))}</li>`).join('') + `</ol>`;
      }
      const podiumIds = new Set([bracket.placings.champion, bracket.placings.runnerUp, bracket.placings.third, bracket.placings.fourth].filter(Boolean));
      const winners = cat.teams.filter((t) => bracket.teamStatus[t.id].label === 'In winners bracket');
      const losers = cat.teams.filter((t) => bracket.teamStatus[t.id].label === 'In losers bracket');
      // 1st-4th are already shown in the podium above once the category is
      // complete; this list is the rest (5th and below), or everyone
      // eliminated so far while the category is still in progress.
      const eliminated = cat.teams.filter((t) => bracket.teamStatus[t.id].label.indexOf('Eliminated') === 0 && !podiumIds.has(t.id))
        .sort((a, b) => (bracket.placings.placeOf[a.id] ? bracket.placings.placeOf[a.id].place : 999) - (bracket.placings.placeOf[b.id] ? bracket.placings.placeOf[b.id].place : 999));
      if (winners.length) html += `<div class="dash-group-title">Alive in winners bracket</div><ul class="dash-team-list">` + winners.map((t) => `<li><span class="pill pill-success">Winners</span> ${escapeHtml(t.name)}</li>`).join('') + `</ul>`;
      if (losers.length) html += `<div class="dash-group-title">Alive in losers bracket</div><ul class="dash-team-list">` + losers.map((t) => `<li><span class="pill pill-warning">Losers</span> ${escapeHtml(t.name)}</li>`).join('') + `</ul>`;
      if (eliminated.length) html += `<div class="dash-group-title">Eliminated</div><ul class="dash-team-list">` + eliminated.map((t) => `<li><span class="pill pill-error">${bracket.placings.placeOf[t.id] ? escapeHtml(bracket.placings.placeOf[t.id].label) : ''}</span> ${escapeHtml(t.name)}</li>`).join('') + `</ul>`;
      html += `</div>`;
      return html;
    }).join('') + `</div>`;
  }

  // ---------------------------------------------------------------- auto-rotate / fullscreen

  let rotateTimer = null;
  function startAutoRotate() {
    stopAutoRotate();
    rotateTimer = setInterval(() => {
      const order = ['courts', 'bracket', 'standings'];
      const idx = order.indexOf(state.dashboard.view);
      state.dashboard.view = order[(idx + 1) % order.length];
      if (state.dashboard.view === 'bracket') {
        state.dashboard.bracketCategory = state.dashboard.bracketCategory === 'A' ? 'B' : 'A';
      }
      renderActive();
    }, 20000);
  }
  function stopAutoRotate() { if (rotateTimer) { clearInterval(rotateTimer); rotateTimer = null; } }
  function toggleAutoRotate() {
    state.dashboard.autoRotate = !state.dashboard.autoRotate;
    if (state.dashboard.autoRotate) startAutoRotate(); else stopAutoRotate();
  }

  function toggleFullscreen() {
    if (!document.fullscreenElement) {
      document.documentElement.requestFullscreen().catch(() => {});
      document.body.classList.add('fullscreen-dash');
    } else {
      document.exitFullscreen().catch(() => {});
    }
  }
  document.addEventListener('fullscreenchange', () => {
    if (!document.fullscreenElement) document.body.classList.remove('fullscreen-dash');
    renderActive();
  });

  // ---------------------------------------------------------------- top-level render

  function render() {
    document.getElementById('event-title-input').value = state.meta.title;
    document.getElementById('danger-banner').hidden = state.dbMode !== 'memory';
    document.getElementById('nudge-banner').hidden = !(state.meta.resultsSinceBackup >= 5 && !state.nudgeDismissed);
    document.querySelectorAll('#tabs button').forEach((btn) => {
      btn.setAttribute('aria-selected', String(btn.dataset.tab === state.activeTab));
    });
    document.querySelectorAll('.view').forEach((v) => v.classList.remove('active'));
    document.getElementById('view-' + state.activeTab).classList.add('active');

    if (state.activeTab === 'setup') {
      document.getElementById('view-setup').innerHTML = renderSetup();
    } else if (state.activeTab === 'score') {
      document.getElementById('view-score').innerHTML = `<div class="score-grid">${renderScoreColumn('A')}${renderScoreColumn('B')}</div>`;
    } else if (state.activeTab === 'dashboard') {
      renderDashboard(document.getElementById('view-dashboard'), { standalone: false });
    }
  }

  function renderActive() {
    if (state.standalone) {
      renderDashboard(document.getElementById('view-dashboard'), { standalone: true });
    } else {
      render();
    }
  }

  // ---------------------------------------------------------------- event delegation

  document.body.addEventListener('input', (e) => {
    const el = e.target;
    const bind = el.dataset && el.dataset.bind;
    if (!bind) return;
    withFocusPreserved(() => {
      if (bind === 'event-title') { state.meta.title = el.value; saveMeta(); }
      else if (bind === 'cat-name') { state.categories[el.dataset.cat].name = el.value; saveCategory(el.dataset.cat); }
      else if (bind === 'cat-court') { state.categories[el.dataset.cat].court = el.value; saveCategory(el.dataset.cat); }
      else if (bind === 'team-name') { updateTeamFieldSync(el.dataset.cat, Number(el.dataset.team), 'name', el.value); saveCategory(el.dataset.cat); }
      else if (bind === 'team-players') { updateTeamFieldSync(el.dataset.cat, Number(el.dataset.team), 'players', el.value); saveCategory(el.dataset.cat); }
      renderActive();
    });
  });

  document.body.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    const action = btn.dataset.action;
    const cat = btn.dataset.cat;
    switch (action) {
      case 'switch-tab': state.activeTab = btn.dataset.tab; render(); break;
      case 'add-team': await addTeam(cat); break;
      case 'delete-team': await deleteTeam(cat, Number(btn.dataset.team)); break;
      case 'move-team': await moveTeam(cat, Number(btn.dataset.team), Number(btn.dataset.dir)); break;
      case 'start-tournament': await startTournament(cat); break;
      case 'reset-category': await resetCategory(cat); break;
      case 'record-result': await handleRecordResult(cat, btn.dataset.match, Number(btn.dataset.winner)); break;
      case 'change-winner': await handleChangeWinner(cat, btn.dataset.match); break;
      case 'clear-result': await handleClearResult(cat, btn.dataset.match); break;
      case 'undo-last': await handleUndoLast(cat); break;
      case 'export-backup': await handleExport(); break;
      case 'trigger-import': triggerImport(); break;
      case 'dismiss-nudge': state.nudgeDismissed = true; renderActive(); break;
      case 'dash-view': state.dashboard.view = btn.dataset.view; renderActive(); break;
      case 'dash-bracket-cat': state.dashboard.bracketCategory = btn.dataset.cat; renderActive(); break;
      case 'dash-toggle-rotate': toggleAutoRotate(); renderActive(); break;
      case 'dash-fullscreen': toggleFullscreen(); break;
      default: break;
    }
  });

  document.getElementById('import-file-input').addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (file) handleImportFile(file);
    e.target.value = '';
  });

  // ---------------------------------------------------------------- boot

  function startPolling() {
    setInterval(async () => {
      const a = await store.getCategory('A');
      const b = await store.getCategory('B');
      const meta = await store.getMeta();
      let changed = false;
      if (!state.categories.A || !a || a.updatedAt !== state.categories.A.updatedAt) { state.categories.A = a; changed = true; }
      if (!state.categories.B || !b || b.updatedAt !== state.categories.B.updatedAt) { state.categories.B = b; changed = true; }
      state.meta = meta || state.meta;
      if (changed) renderDashboard(document.getElementById('view-dashboard'), { standalone: true });
    }, 1500);
  }

  async function boot() {
    const standalone = location.hash === '#dashboard';
    state.standalone = standalone;
    state.dbMode = await store.init();
    state.categories.A = await store.getCategory('A');
    state.categories.B = await store.getCategory('B');
    state.meta = await store.getMeta();

    if (standalone) {
      document.getElementById('topbar').hidden = true;
      document.getElementById('nudge-banner').hidden = true;
      document.getElementById('danger-banner').hidden = state.dbMode !== 'memory';
      document.querySelectorAll('main > .view').forEach((v) => { v.hidden = true; v.classList.remove('active'); });
      const dashView = document.getElementById('view-dashboard');
      dashView.hidden = false;
      dashView.classList.add('active');
      renderDashboard(dashView, { standalone: true });
      startPolling();
      return;
    }

    state.activeTab = 'setup';
    render();
  }

  document.addEventListener('DOMContentLoaded', boot);
})();
