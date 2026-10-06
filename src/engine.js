// Pure bracket engine. No DOM access. See plan.md section 3.
//
// computeBracket(teams, results) recomputes the entire bracket state from
// scratch every time. Nothing about the bracket itself is ever stored -
// only `teams` (seed order) and `results` (matchId -> {winnerId, at}) are
// persisted. This is what makes undo/correction safe: just mutate results
// and recompute.

(function (root) {
  'use strict';

  // ---------------------------------------------------------------------
  // 3.1 Sizing and seeding
  // ---------------------------------------------------------------------

  function bracketSize(T) {
    if (T <= 4) return 4;
    if (T <= 8) return 8;
    return 16;
  }

  function seedOrder(N) {
    let order = [1, 2];
    while (order.length < N) {
      const len = order.length;
      const next = [];
      for (const x of order) {
        next.push(x, 2 * len + 1 - x);
      }
      order = next;
    }
    return order;
  }

  // ---------------------------------------------------------------------
  // 3.2 Match graph (static, depends only on N)
  // ---------------------------------------------------------------------

  function losersRoundCount(N, r) {
    return N / Math.pow(2, Math.ceil(r / 2) + 1);
  }

  function buildGraph(N, k) {
    const matches = {};
    const order = seedOrder(N);

    // Winners bracket
    for (let r = 1; r <= k; r++) {
      const count = N / Math.pow(2, r);
      for (let i = 0; i < count; i++) {
        const id = `W${r}-${i + 1}`;
        let slotA, slotB;
        if (r === 1) {
          slotA = { type: 'seed', n: order[2 * i] };
          slotB = { type: 'seed', n: order[2 * i + 1] };
        } else {
          slotA = { type: 'winnerOf', id: `W${r - 1}-${2 * i + 1}` };
          slotB = { type: 'winnerOf', id: `W${r - 1}-${2 * i + 2}` };
        }
        matches[id] = { id, phase: 'W', round: r, index: i, slotA, slotB };
      }
    }

    // Losers bracket
    const totalLosersRounds = 2 * k - 2;
    for (let r = 1; r <= totalLosersRounds; r++) {
      const count = losersRoundCount(N, r);
      for (let i = 0; i < count; i++) {
        const id = `L${r}-${i + 1}`;
        let slotA, slotB;
        if (r === 1) {
          slotA = { type: 'loserOf', id: `W1-${2 * i + 1}` };
          slotB = { type: 'loserOf', id: `W1-${2 * i + 2}` };
        } else if (r % 2 === 0) {
          const j = r / 2;
          const wCount = N / Math.pow(2, j + 1);
          const d = j % 2 === 1 ? wCount - 1 - i : i;
          slotA = { type: 'winnerOf', id: `L${r - 1}-${i + 1}` };
          slotB = { type: 'loserOf', id: `W${j + 1}-${d + 1}` };
        } else {
          slotA = { type: 'winnerOf', id: `L${r - 1}-${2 * i + 1}` };
          slotB = { type: 'winnerOf', id: `L${r - 1}-${2 * i + 2}` };
        }
        matches[id] = { id, phase: 'L', round: r, index: i, slotA, slotB };
      }
    }

    // Grand final
    matches.GF1 = {
      id: 'GF1', phase: 'GF', round: 1, index: 0,
      slotA: { type: 'winnerOf', id: `W${k}-1` },
      slotB: { type: 'winnerOf', id: `L${totalLosersRounds}-1` },
    };
    matches.GF2 = {
      id: 'GF2', phase: 'GF', round: 2, index: 0,
      slotA: { type: 'winnerOf', id: `W${k}-1` },
      slotB: { type: 'winnerOf', id: `L${totalLosersRounds}-1` },
    };

    return matches;
  }

  // 3.4 Match numbering order (structural, per N/k)
  function buildNumberingOrder(N, k) {
    const seq = [];
    const pushRound = (phase, r, count) => {
      for (let i = 1; i <= count; i++) seq.push(`${phase}${r}-${i}`);
    };
    pushRound('W', 1, N / 2);
    pushRound('L', 1, losersRoundCount(N, 1));
    for (let r = 2; r <= k; r++) {
      pushRound('W', r, N / Math.pow(2, r));
      const lEven = 2 * r - 2;
      pushRound('L', lEven, losersRoundCount(N, lEven));
      if (r <= k - 1) {
        const lOdd = 2 * r - 1;
        pushRound('L', lOdd, losersRoundCount(N, lOdd));
      }
    }
    seq.push('GF1', 'GF2');
    return seq;
  }

  // ---------------------------------------------------------------------
  // 3.3 Slot resolution
  // ---------------------------------------------------------------------

  function resolveSlot(slot, graph, teams, results, memo) {
    if (slot.type === 'seed') {
      const n = slot.n;
      if (n > teams.length) return { kind: 'bye' };
      return { kind: 'team', teamId: teams[n - 1].id };
    }
    const m = resolveMatch(slot.id, graph, teams, results, memo);
    return slot.type === 'winnerOf' ? m.winner : m.loser;
  }

  function decideFromResult(a, b, result) {
    if (a.kind === 'team' && b.kind === 'team' && result &&
      (result.winnerId === a.teamId || result.winnerId === b.teamId)) {
      return result.winnerId === a.teamId
        ? { winner: a, loser: b }
        : { winner: b, loser: a };
    }
    return { winner: { kind: 'pending' }, loser: { kind: 'pending' } };
  }

  function resolveMatch(matchId, graph, teams, results, memo) {
    if (memo.has(matchId)) return memo.get(matchId);

    // Insert a placeholder to guard against accidental cycles during dev.
    memo.set(matchId, null);

    const def = graph[matchId];
    const a = resolveSlot(def.slotA, graph, teams, results, memo);
    const b = resolveSlot(def.slotB, graph, teams, results, memo);

    let winner, loser, isBye, skipped;

    if (matchId === 'GF2') {
      const gf1 = resolveMatch('GF1', graph, teams, results, memo);
      if (gf1.winner.kind !== 'team') {
        // GF1 not yet decided: GF2 is "if needed", i.e. normal pending match.
        skipped = false;
        winner = { kind: 'pending' };
        loser = { kind: 'pending' };
      } else if (gf1.winner.teamId === gf1.slotA.teamId) {
        // Winners-bracket champion won GF1 outright: no reset needed.
        skipped = true;
        winner = { kind: 'bye' };
        loser = { kind: 'bye' };
      } else {
        // Losers-bracket champion won GF1: GF2 is required.
        skipped = false;
        const d = decideFromResult(a, b, results[matchId]);
        winner = d.winner;
        loser = d.loser;
      }
      isBye = skipped;
    } else if (a.kind === 'bye' && b.kind === 'bye') {
      winner = { kind: 'bye' };
      loser = { kind: 'bye' };
      isBye = true;
      skipped = false;
    } else if (a.kind === 'bye' || b.kind === 'bye') {
      const other = a.kind === 'bye' ? b : a;
      winner = other;
      loser = { kind: 'bye' };
      isBye = true;
      skipped = false;
    } else {
      const d = decideFromResult(a, b, results[matchId]);
      winner = d.winner;
      loser = d.loser;
      isBye = false;
      skipped = false;
    }

    const resolved = { id: matchId, def, slotA: a, slotB: b, winner, loser, isBye, skipped };
    memo.set(matchId, resolved);
    return resolved;
  }

  // ---------------------------------------------------------------------
  // 3.7 Placings
  // ---------------------------------------------------------------------

  function computePlacings(resolved, N, k, order) {
    const lastLosersRound = 2 * k - 2;
    const prevLosersRound = lastLosersRound - 1;

    const gf1 = resolved.GF1;
    const gf2 = resolved.GF2;

    let champion = null;
    let runnerUp = null;
    if (!gf2.isBye && gf2.winner.kind === 'team') {
      // GF2 was required and has been played: its winner is champion.
      champion = gf2.winner.teamId;
      runnerUp = gf2.loser.kind === 'team' ? gf2.loser.teamId : null;
    } else if (gf2.isBye && gf1.winner.kind === 'team') {
      // GF2 was skipped (winners-bracket champion won GF1 outright).
      champion = gf1.winner.teamId;
      runnerUp = gf1.loser.kind === 'team' ? gf1.loser.teamId : null;
    }
    // Otherwise GF2 is required but not yet played: no champion yet.

    const thirdMatch = resolved[`L${lastLosersRound}-1`];
    const third = thirdMatch && thirdMatch.loser.kind === 'team' ? thirdMatch.loser.teamId : null;
    const fourthMatch = prevLosersRound >= 1 ? resolved[`L${prevLosersRound}-1`] : null;
    const fourth = fourthMatch && fourthMatch.loser.kind === 'team' ? fourthMatch.loser.teamId : null;

    const placeOf = {};
    if (champion) placeOf[champion] = { place: 1, label: '1st' };
    if (runnerUp) placeOf[runnerUp] = { place: 2, label: '2nd' };
    if (third) placeOf[third] = { place: 3, label: '3rd' };
    if (fourth) placeOf[fourth] = { place: 4, label: '4th' };

    // Remaining teams, grouped by losers round of elimination, latest first.
    let runningRank = 5;
    for (let r = lastLosersRound - 2; r >= 1; r--) {
      const count = losersRoundCount(resolved.__N, r);
      const groupTeams = [];
      for (let i = 1; i <= count; i++) {
        const m = resolved[`L${r}-${i}`];
        if (m && m.loser.kind === 'team' && !placeOf[m.loser.teamId]) {
          groupTeams.push(m.loser.teamId);
        }
      }
      if (groupTeams.length === 0) continue;
      const start = runningRank;
      const end = runningRank + groupTeams.length - 1;
      const label = start === end ? ordinal(start) : `${ordinal(start)}–${ordinal(end)}`;
      for (const teamId of groupTeams) {
        placeOf[teamId] = { place: start, placeEnd: end, label };
      }
      runningRank = end + 1;
    }

    return { champion, runnerUp, third, fourth, placeOf };
  }

  function ordinal(n) {
    const s = ['th', 'st', 'nd', 'rd'];
    const v = n % 100;
    return n + (s[(v - 20) % 10] || s[v] || s[0]);
  }

  // ---------------------------------------------------------------------
  // Main entry point
  // ---------------------------------------------------------------------

  function computeBracket(teams, results) {
    results = results || {};
    const T = teams.length;
    const N = bracketSize(T);
    const k = Math.log2(N);
    const graph = buildGraph(N, k);
    const seq = buildNumberingOrder(N, k);
    const memo = new Map();

    const resolved = { __N: N };
    for (const id of seq) {
      resolved[id] = resolveMatch(id, graph, teams, results, memo);
    }

    let num = 1;
    for (const id of seq) {
      const m = resolved[id];
      m.number = m.isBye ? null : num++;
    }
    const totalReal = num - 1;

    const byNumber = seq.filter((id) => !resolved[id].isBye)
      .map((id) => resolved[id])
      .sort((a, b) => a.number - b.number);

    const playable = byNumber.filter((m) =>
      m.slotA.kind === 'team' && m.slotB.kind === 'team' && m.winner.kind === 'pending');

    const comingUp = byNumber.filter((m) => {
      const known = (m.slotA.kind === 'team' ? 1 : 0) + (m.slotB.kind === 'team' ? 1 : 0);
      return known === 1 && m.winner.kind === 'pending';
    }).slice(0, 5);

    const nowPlaying = playable[0] || null;
    const upNext = playable.slice(1, 4);

    const placings = computePlacings(resolved, N, k, seq);
    const resetPlayed = !resolved.GF2.isBye && resolved.GF2.winner.kind === 'team';

    const teamStatus = {};
    for (const team of teams) {
      teamStatus[team.id] = statusFor(team.id, resolved, placings, N, k);
    }

    return {
      N, k, T,
      matches: resolved,
      order: seq,
      totalReal,
      playable,
      nowPlaying,
      upNext,
      comingUp,
      placings,
      champion: placings.champion,
      resetPlayed,
      teamStatus,
    };
  }

  function statusFor(teamId, resolved, placings, N, k) {
    if (placings.champion === teamId) return { label: 'Champion' };
    const place = placings.placeOf[teamId];
    if (place) return { label: `Eliminated (${place.label})`, place: place.place, placeLabel: place.label };

    let losses = 0;
    for (const id of Object.keys(resolved)) {
      if (id === '__N') continue;
      const m = resolved[id];
      if (!m.isBye && m.loser.kind === 'team' && m.loser.teamId === teamId) losses++;
    }
    if (losses >= 1) return { label: 'In losers bracket' };
    return { label: 'In winners bracket' };
  }

  // ---------------------------------------------------------------------
  // 3.6 Results, undo, corrections, pruning
  // ---------------------------------------------------------------------

  function setResult(teams, results, matchId, winnerId, at) {
    const bracket = computeBracket(teams, results);
    const m = bracket.matches[matchId];
    if (!m) throw new Error(`Unknown match ${matchId}`);
    if (m.isBye) throw new Error(`Match ${matchId} is not playable`);
    if (m.slotA.kind !== 'team' || m.slotB.kind !== 'team') {
      throw new Error(`Match ${matchId} does not have both teams known`);
    }
    if (winnerId !== m.slotA.teamId && winnerId !== m.slotB.teamId) {
      throw new Error(`${winnerId} is not a team in match ${matchId}`);
    }
    const next = Object.assign({}, results);
    next[matchId] = { winnerId, at: at == null ? Date.now() : at };
    return next;
  }

  function clearResult(results, matchId) {
    const next = Object.assign({}, results);
    delete next[matchId];
    return next;
  }

  function findLastResultId(results) {
    let bestId = null;
    let bestAt = -Infinity;
    for (const id of Object.keys(results)) {
      if (results[id].at > bestAt) {
        bestAt = results[id].at;
        bestId = id;
      }
    }
    return bestId;
  }

  // Repeatedly delete any result whose match is no longer playable-or-decided,
  // whose two teams are no longer both known, or whose winner is not one of
  // its two current teams. Cascades until stable.
  function pruneResults(teams, results) {
    let current = Object.assign({}, results);
    while (true) {
      const bracket = computeBracket(teams, current);
      let changed = false;
      for (const matchId of Object.keys(current)) {
        const m = bracket.matches[matchId];
        const validTeams = m && m.slotA.kind === 'team' && m.slotB.kind === 'team';
        const winnerOk = validTeams &&
          (current[matchId].winnerId === m.slotA.teamId || current[matchId].winnerId === m.slotB.teamId);
        if (!m || m.isBye || !validTeams || !winnerOk) {
          delete current[matchId];
          changed = true;
        }
      }
      if (!changed) break;
    }
    return current;
  }

  // Returns the list of matchIds that would be removed (beyond matchId
  // itself, if given) if `nextResults` were applied and then pruned. Used to
  // populate the "this will clear these matches" confirmation dialog.
  function diffPrune(teams, beforeResults, nextResults) {
    const pruned = pruneResults(teams, nextResults);
    const removed = [];
    for (const id of Object.keys(nextResults)) {
      if (!(id in pruned)) removed.push(id);
    }
    return { prunedResults: pruned, removedIds: removed };
  }

  const Engine = {
    bracketSize,
    seedOrder,
    buildGraph,
    buildNumberingOrder,
    computeBracket,
    setResult,
    clearResult,
    findLastResultId,
    pruneResults,
    diffPrune,
    ordinal,
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = Engine;
  } else {
    root.Engine = Engine;
  }
})(typeof window !== 'undefined' ? window : globalThis);
