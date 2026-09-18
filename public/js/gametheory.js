/**
 * Game Theory Decision Engine for Fantasy Hockey Drafts (Enhanced VONA/EVONA)
 * 
 * Key mathematical enhancements:
 * 1. High-precision normal CDF (Abramowitz & Stegun 7.1.26) for survival odds P(Survives).
 * 2. Dynamic Positional Cliffs: computes live drop-off to the next available undrafted player.
 * 3. Multi-position eligibility optionality: avoids penalizing dual-eligible players if one position is open.
 * 4. Graded diminishing returns curve (Starters 100%, Primary Bench 85%, Deep Bench 65%).
 * 5. Generalized EVONA Trade-off Comparator: fully accounts for mutual survival odds and intra-position matchups without divide-by-zero errors.
 * 6. Continuous Urgency Scoring to break ties cleanly.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.GameTheory = factory();
  }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  /**
   * Standard normal cumulative distribution function (CDF)
   * Abramowitz & Stegun formula 7.1.26 (error < 1.5e-7)
   */
  function normalCDF(x, mean, std) {
    if (!std || std <= 0) std = 7.0;
    if (x === null || x === undefined || isNaN(x)) return 0.5;
    var z = (x - mean) / std;
    var absZ = Math.abs(z);
    var t = 1.0 / (1.0 + 0.2316419 * absZ);
    var zPdf = (1.0 / Math.sqrt(2.0 * Math.PI)) * Math.exp(-0.5 * absZ * absZ);
    var tail = zPdf * (t * (0.319381530 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429)))));
    var cdf = z >= 0 ? (1.0 - tail) : tail;
    return Math.max(0, Math.min(1, cdf));
  }

  /**
   * Survival Probability to target turn:
   * P(Survive) = 1 - NORM.DIST(targetTurn, ADP, std, TRUE)
   */
  function pSurvive(targetPick, adp, std) {
    if (!adp || isNaN(adp)) return 0.5;
    std = std || 7.0;
    var cdf = normalCDF(targetPick, adp, std);
    return Math.max(0, Math.min(1, 1.0 - cdf));
  }

  /**
   * Snake Draft Turn Schedule Calculator
   */
  function getNextSnakePick(currentPick, slot, teams) {
    slot = parseInt(slot, 10) || 1;
    teams = parseInt(teams, 10) || 8;
    currentPick = parseInt(currentPick, 10) || 1;

    var rnd = Math.floor((currentPick - 1) / teams) + 1;
    var isOddRnd = (rnd % 2) === 1;
    var pickInCurRnd = (rnd - 1) * teams + (isOddRnd ? slot : teams - slot + 1);

    if (currentPick < pickInCurRnd) {
      return pickInCurRnd;
    }
    var nextRnd = rnd + 1;
    var isOddNext = (nextRnd % 2) === 1;
    return rnd * teams + (isOddNext ? slot : teams - slot + 1);
  }

  function getPickDetails(overallPick, teams) {
    teams = parseInt(teams, 10) || 8;
    var round = Math.floor((overallPick - 1) / teams) + 1;
    var pickInRound = ((overallPick - 1) % teams) + 1;
    var isOdd = (round % 2) === 1;
    var ownerSlot = isOdd ? pickInRound : (teams - pickInRound + 1);
    return {
      round: round,
      pickInRound: pickInRound,
      ownerSlot: ownerSlot
    };
  }

  function isMyTurn(currentPick, slot, teams) {
    var details = getPickDetails(currentPick, teams);
    return details.ownerSlot === parseInt(slot, 10);
  }

  function getCliffAlert(dropoff) {
    if (dropoff === null || dropoff === undefined || isNaN(dropoff)) return "Flat";
    if (dropoff >= 20) return "CRITICAL CLIFF";
    if (dropoff >= 10) return "Tier Drop";
    return "Flat";
  }

  /**
   * Graded Positional Diminishing Returns Curve
   * - Under starter limit: 1.0 (100% utility)
   * - At starter limit (1st bench): 0.85
   * - 1 over limit (2nd bench): 0.65
   * - 2+ over limit (excess): 0.35
   * Multi-position players use the most favorable open slot.
   */
  function getDiminishingMultiplier(positions, myRosterCounts, limits) {
    limits = limits || { C: 3, F: 5, D: 4, G: 2 };
    if (!positions || !positions.length) return 1.0;

    var bestMultiplier = 0.0;
    for (var i = 0; i < positions.length; i++) {
      var p = positions[i];
      var count = (myRosterCounts && myRosterCounts[p]) || 0;
      var limit = limits[p] || 4;

      var mult = 1.0;
      if (count < limit) {
        mult = 1.0;
      } else if (count === limit) {
        mult = 0.85;
      } else if (count === limit + 1) {
        mult = 0.65;
      } else {
        mult = 0.35;
      }

      if (mult > bestMultiplier) {
        bestMultiplier = mult;
      }
    }
    return bestMultiplier > 0 ? bestMultiplier : 1.0;
  }

  function classifyAction(isDrafted, isMine, survivalOdds, dropoff) {
    if (isMine) return "MY TEAM";
    if (isDrafted) return "DRAFTED";
    if (survivalOdds > 0.75) return "WAIT (ADP Safe)";
    if (survivalOdds < 0.35 && dropoff >= 15) return "MUST REACH (Cliff)";
    if (survivalOdds < 0.20) return "NOW OR NEVER";
    return "TARGET";
  }

  /**
   * Calculate Dynamic Positional Cliffs among currently available undrafted players
   */
  function computeDynamicCliffs(availablePlayers) {
    var posMap = {};
    for (var i = 0; i < availablePlayers.length; i++) {
      var p = availablePlayers[i];
      var vorp = p.rawVorp || p.vorp || 0;
      var positions = p.pos || [];
      for (var j = 0; j < positions.length; j++) {
        var pos = positions[j];
        if (!posMap[pos]) posMap[pos] = [];
        posMap[pos].push({ id: p.id, name: p.name, vorp: vorp });
      }
    }

    for (var k in posMap) {
      posMap[k].sort(function (a, b) { return b.vorp - a.vorp; });
    }

    var dynamicCliffMap = {};
    for (var m = 0; m < availablePlayers.length; m++) {
      var pl = availablePlayers[m];
      var plVorp = pl.rawVorp || pl.vorp || 0;
      var plPos = pl.pos || [];

      var maxCliff = 0;
      for (var n = 0; n < plPos.length; n++) {
        var list = posMap[plPos[n]] || [];
        var myIdx = -1;
        for (var l = 0; l < list.length; l++) {
          if (list[l].name === pl.name) {
            myIdx = l;
            break;
          }
        }

        if (myIdx !== -1) {
          var nextPl = list[myIdx + 1];
          var directDrop = nextPl ? (plVorp - nextPl.vorp) : plVorp;
          var tierDrop = directDrop;
          if (nextPl && directDrop < 15 && (myIdx + 2 < list.length)) {
            var tierNext = list[myIdx + 2];
            var nextDrop = nextPl.vorp - tierNext.vorp;
            if (nextDrop >= 15) {
              tierDrop = plVorp - tierNext.vorp;
            }
          }
          var effectiveCliff = Math.max(directDrop, tierDrop);
          if (effectiveCliff > maxCliff) maxCliff = effectiveCliff;
        }
      }
      dynamicCliffMap[pl.name] = maxCliff > 0 ? maxCliff : (pl.dropoff || 0);
    }
    return dynamicCliffMap;
  }

  /**
   * Step-by-Step Decision Protocol on the Clock
   */
  function evaluateBoard(rows, options) {
    var currentPick = options.currentPick || 1;
    var slot = options.slot || 5;
    var teams = options.teams || 8;
    var stdDev = options.stdDev || 7.0;
    var draftedSet = options.drafted || {};
    var mineSet = options.mine || {};
    var rosterCounts = options.rosterCounts || { C: 0, LW: 0, RW: 0, D: 0, G: 0 };
    var rosterLimits = options.rosterLimits || { C: 3, F: 5, D: 4, G: 2 };

    var onTheClock = isMyTurn(currentPick, slot, teams);
    var targetTurn = onTheClock
      ? getNextSnakePick(currentPick + 1, slot, teams)
      : getNextSnakePick(currentPick, slot, teams);

    var picksUntilTurn = onTheClock ? 0 : Math.max(0, targetTurn - currentPick);

    // Initial pass: identify available players for dynamic cliff calculation
    var rawAvailable = [];
    for (var rIdx = 0; rIdx < rows.length; rIdx++) {
      var rowItem = rows[rIdx];
      var pName = rowItem.name || rowItem.n;
      if (!mineSet[pName] && !draftedSet[pName]) {
        rawAvailable.push({
          id: rowItem.id !== undefined ? rowItem.id : rIdx,
          name: pName,
          pos: rowItem.pos || rowItem.p || [],
          rawVorp: rowItem.vorp !== undefined ? rowItem.vorp : (rowItem.rawVorp || 0),
          dropoff: rowItem.dropoff || 0
        });
      }
    }

    var dynamicCliffs = computeDynamicCliffs(rawAvailable);

    var evaluatedRows = [];
    var availableRows = [];

    for (var i = 0; i < rows.length; i++) {
      var r = rows[i];
      var name = r.name || r.n;
      var isMine = !!mineSet[name];
      var isDrafted = isMine || !!draftedSet[name];

      var adpVal = (r.adp && typeof r.adp === "object")
        ? (r.adp.yahoo || r.adp.average || r.adp.fantrax)
        : r.adp;
      var adpNum = parseFloat(adpVal) || 999;

      var surv = isDrafted ? 0 : pSurvive(targetTurn, adpNum, stdDev);
      var posArray = r.pos || r.p || [];
      var mult = getDiminishingMultiplier(posArray, rosterCounts, rosterLimits);
      var rawVorp = r.vorp !== undefined ? r.vorp : (r.rawVorp || 0);
      var adjVorp = rawVorp * mult;

      // Use dynamic cliff if available, else static dropoff
      var drop = (!isDrafted && dynamicCliffs[name] !== undefined)
        ? dynamicCliffs[name]
        : (r.dropoff !== undefined ? r.dropoff : 0);

      var cliff = getCliffAlert(drop);
      var action = classifyAction(isDrafted, isMine, surv, drop);
      var adpDelta = (adpNum < 900 && r.rank) ? (adpNum - r.rank) : 0;

      // Continuous urgency score: Intrinsic Value * (1 + Urgency) + Cliff * Urgency
      var urgency = 1.0 - surv;
      var urgencyScore = adjVorp * (1.0 + 0.6 * urgency) + (drop * urgency * 0.4);

      var evalRow = {
        id: r.id !== undefined ? r.id : i,
        name: name,
        team: r.team || r.t || "",
        pos: posArray,
        posLabel: r.posLabel || posArray.join("/"),
        age: r.age,
        adp: adpNum < 900 ? adpNum : null,
        adpDelta: adpDelta,
        rawVorp: rawVorp,
        adjVorp: adjVorp,
        dropoff: drop,
        cliffAlert: cliff,
        survivalProb: surv,
        action: action,
        isDrafted: isDrafted,
        isMine: isMine,
        tier: r.tier || 1,
        rank: r.rank || (i + 1),
        isDiminished: mult < 1.0,
        urgencyScore: urgencyScore,
        fp: r.fp || 0,
        fpg: r.fpg || 0
      };

      evaluatedRows.push(evalRow);
      if (!isDrafted) {
        availableRows.push(evalRow);
      }
    }

    // Step 1: Automated Game Theory Multi-Candidate Trade-Off Analysis
    var gtData = computeTargetTradeoffs(availableRows, targetTurn, stdDev);
    for (var g = 0; g < availableRows.length; g++) {
      var avRow = availableRows[g];
      avRow.gtTradeoff = (gtData && gtData.tradeoffs) ? gtData.tradeoffs[avRow.name] : null;
    }

    // Step 2: Red Alerts (MUST REACH Cliff)
    var redAlerts = availableRows.filter(function (p) {
      return p.action === "MUST REACH (Cliff)" && !p.isDiminished;
    });

    // Step 3: Safe Sleepers
    var waitSafePlayers = availableRows.filter(function (p) {
      return p.action === "WAIT (ADP Safe)" && p.adjVorp >= 15;
    }).sort(function (a, b) {
      return b.adjVorp - a.adjVorp;
    });

    // Step 4: Rank Shortlist according to 2-Round EV & Decision Protocol
    var shortlistCandidates = availableRows.filter(function (p) {
      return p.action !== "WAIT (ADP Safe)";
    });

    shortlistCandidates.sort(function (a, b) {
      var gtAdvA = (a.gtTradeoff && typeof a.gtTradeoff.netGain === "number") ? a.gtTradeoff.netGain : 0;
      var gtAdvB = (b.gtTradeoff && typeof b.gtTradeoff.netGain === "number") ? b.gtTradeoff.netGain : 0;

      // If one candidate has a decisive Game Theory 2-Round EV edge (>= 2.0 pts):
      if (gtAdvA >= 2.0 && gtAdvB < 2.0) return -1;
      if (gtAdvB >= 2.0 && gtAdvA < 2.0) return 1;

      // Composite Game Theory score: EV2 + Expected Cliff Loss
      var scoreA = (a.gtTradeoff && a.gtTradeoff.ev2 ? a.gtTradeoff.ev2 : a.adjVorp) + (1.0 - a.survivalProb) * a.dropoff;
      var scoreB = (b.gtTradeoff && b.gtTradeoff.ev2 ? b.gtTradeoff.ev2 : b.adjVorp) + (1.0 - b.survivalProb) * b.dropoff;

      if (Math.abs(scoreB - scoreA) >= 3.0) {
        return scoreB - scoreA;
      }

      // If VORP difference is significant (>= 4.0 pts), higher VORP dominates
      var vorpDiff = b.adjVorp - a.adjVorp;
      if (Math.abs(vorpDiff) >= 4.0) {
        return vorpDiff;
      }

      // Steeper cliff breaks tie
      var cliffDiff = b.dropoff - a.dropoff;
      if (Math.abs(cliffDiff) >= 2.0) {
        return cliffDiff;
      }

      // Lower survival (higher urgency) breaks tie
      var survDiff = a.survivalProb - b.survivalProb;
      if (Math.abs(survDiff) > 0.15) {
        return survDiff;
      }

      return vorpDiff;
    });

    var shortlist = shortlistCandidates.slice(0, 8);

    // Live directions
    var liveProtocol = {
      step: 1,
      alertType: "info",
      headline: "",
      subtext: "",
      bestPick: shortlist[0] || null,
      onTheClock: onTheClock,
      currentPick: currentPick,
      targetTurn: targetTurn,
      picksUntilTurn: picksUntilTurn
    };

    if (onTheClock) {
      if (shortlist.length > 0 && shortlist[0].gtTradeoff && shortlist[0].gtTradeoff.netGain >= 2.0) {
        liveProtocol.alertType = "turn";
        liveProtocol.step = 3;
        liveProtocol.headline = "🎯 GAME THEORY PICK: Draft " + shortlist[0].name + " (" + shortlist[0].posLabel + ")";
        liveProtocol.subtext = shortlist[0].gtTradeoff.advice;
      } else if (redAlerts.length > 0) {
        liveProtocol.alertType = "critical";
        liveProtocol.step = 1;
        liveProtocol.headline = "🚨 CRITICAL CLIFF DETECTED: MUST REACH NOW";
        liveProtocol.subtext = redAlerts[0].gtTradeoff ? redAlerts[0].gtTradeoff.advice : (redAlerts[0].name + " (" + redAlerts[0].posLabel + ") sits atop a +" +
          redAlerts[0].dropoff.toFixed(1) + " VORP cliff with only " + (redAlerts[0].survivalProb * 100).toFixed(0) +
          "% odds to reach your next pick (#" + targetTurn + "). Passing forfeits irreplaceable value.");
      } else if (shortlist.length > 0 && shortlist[0].action === "NOW OR NEVER") {
        liveProtocol.alertType = "warning";
        liveProtocol.step = 2;
        liveProtocol.headline = "⚡ ON THE CLOCK: IMMINENT TARGET DISAPPEARING";
        liveProtocol.subtext = shortlist[0].gtTradeoff ? shortlist[0].gtTradeoff.advice : (shortlist[0].name + " (" + shortlist[0].posLabel + ") has <20% survival to pick #" +
          targetTurn + " and high Adj VORP (" + shortlist[0].adjVorp.toFixed(1) + "). Lock in before opponents strike.");
      } else if (shortlist.length > 0) {
        liveProtocol.alertType = "turn";
        liveProtocol.step = 3;
        liveProtocol.headline = "🎯 ON THE CLOCK: TAKE BEST VALUE";
        liveProtocol.subtext = shortlist[0].gtTradeoff ? shortlist[0].gtTradeoff.advice : ("Top recommendation: " + shortlist[0].name + " (" + shortlist[0].posLabel + ", Adj VORP " +
          shortlist[0].adjVorp.toFixed(1) + ", Cliff +" + shortlist[0].dropoff.toFixed(1) + "). Safe sleepers like " +
          (waitSafePlayers[0] ? waitSafePlayers[0].name : "late ADPs") + " will fall back to you.");
      }
    } else {
      liveProtocol.alertType = "waiting";
      liveProtocol.headline = "⏱️ Drafting in " + picksUntilTurn + " picks (Turn #" + targetTurn + ")";
      if (shortlist.length > 0 && shortlist[0].gtTradeoff && shortlist[0].gtTradeoff.netGain >= 2.0) {
        liveProtocol.subtext = "Game Theory Target: " + shortlist[0].name + " (" + shortlist[0].posLabel + ") holds +" +
          shortlist[0].gtTradeoff.netGain.toFixed(1) + " EV advantage over field.";
      } else if (redAlerts.length > 0) {
        liveProtocol.subtext = "Tracking Red Alert: " + redAlerts[0].name + " (" + (redAlerts[0].survivalProb * 100).toFixed(0) +
          "% survival). Prepare to draft if opponents pass.";
      } else if (shortlist.length > 0) {
        liveProtocol.subtext = "Top target queue: " + shortlist[0].name + " (" + shortlist[0].posLabel + ") and " +
          (shortlist[1] ? shortlist[1].name : "next best");
      }
    }

    var topMatchup = getTopMatchup(availableRows, targetTurn, stdDev);

    return {
      allRows: evaluatedRows,
      availableRows: availableRows,
      shortlist: shortlist,
      redAlerts: redAlerts,
      waitSafePlayers: waitSafePlayers.slice(0, 5),
      liveProtocol: liveProtocol,
      topMatchup: topMatchup,
      onTheClock: onTheClock,
      targetTurn: targetTurn,
      currentPick: currentPick,
      picksUntilTurn: picksUntilTurn
    };
  }

  /**
   * Generalized EVONA Head-to-Head Trade-Off Evaluator
   * Fully accounts for cross-positional alternatives and dual survival odds:
   * EV(Pick B) = VORP(B) + P(A)*VORP(A) + (1-P(A))*VORP(A')
   * EV(Pick A) = VORP(A) + P(B)*VORP(B) + (1-P(B))*VORP(B')
   */
  function comparePlayersGameTheory(playerA, playerB, nextAltA, nextAltB, targetTurn, stdDev) {
    if (!playerA || !playerB) return null;
    stdDev = stdDev || 7.0;

    var vorpA = playerA.adjVorp || playerA.rawVorp || playerA.vorp || 0;
    var vorpB = playerB.adjVorp || playerB.rawVorp || playerB.vorp || 0;

    var altVorpA = nextAltA
      ? (nextAltA.adjVorp || nextAltA.rawVorp || 0)
      : Math.max(0, vorpA - (playerA.dropoff || 10));

    var altVorpB = nextAltB
      ? (nextAltB.adjVorp || nextAltB.rawVorp || 0)
      : Math.max(0, vorpB - (playerB.dropoff || 10));

    var lossA = Math.max(0.1, vorpA - altVorpA);
    var lossB = Math.max(0.1, vorpB - altVorpB);

    var adpA = playerA.adp || 100;
    var adpB = playerB.adp || 100;

    var pA = pSurvive(targetTurn, adpA, stdDev);
    var pB = pSurvive(targetTurn, adpB, stdDev);

    // Option 1: Pick B now, gamble on A reaching your next turn
    var evOption1 = vorpB + (pA * vorpA) + ((1.0 - pA) * altVorpA);

    // Option 2: Pick A now, gamble on B reaching your next turn (usually pB ~ 0 if imminent)
    var evOption2 = vorpA + (pB * vorpB) + ((1.0 - pB) * altVorpB);

    var deltaEV = evOption1 - evOption2;
    var waitOnA = deltaEV >= 0;

    var threshold = lossA > 0 ? (lossB / lossA) : 1.0;

    var verdict = waitOnA
      ? "EXPLOIT MARKET: Take " + playerB.name + " now. Wait on " + playerA.name + " (ΔEV: +" + deltaEV.toFixed(1) + " pts, " + (pA * 100).toFixed(0) + "% survival)."
      : "LOCK IN VALUE: Draft " + playerA.name + " now. Do not gamble on ADP (ΔEV: +" + Math.abs(deltaEV).toFixed(1) + " pts for Option 2).";

    return {
      playerA: playerA,
      playerB: playerB,
      lossA: lossA,
      lossB: lossB,
      pSurviveA: pA,
      pSurviveB: pB,
      threshold: threshold,
      evOption1: evOption1,
      evOption2: evOption2,
      deltaEV: deltaEV,
      waitOnA: waitOnA,
      verdict: verdict
    };
  }

  /**
   * Evaluates Game Theory Trade-Offs automatically across all available targets.
   * Compares each candidate against the board's top VORP anchor (pTop) or the top challenger.
   */
  function computeTargetTradeoffs(availableRows, targetTurn, stdDev) {
    if (!availableRows || !availableRows.length) return { tradeoffs: {}, pTop: null, pChallenger: null, bestGTCandidate: null, topNetGain: -999 };
    stdDev = stdDev || 7.0;

    var sorted = availableRows.slice().sort(function (a, b) {
      return b.adjVorp - a.adjVorp;
    });

    var pTop = sorted[0];
    if (!pTop) return { tradeoffs: {}, pTop: null, pChallenger: null, bestGTCandidate: null, topNetGain: -999 };

    // Identify top cliff / urgency challenger among top 15
    var pChallenger = null;
    var maxLoss = -1;
    var limit = Math.min(sorted.length, 15);
    for (var i = 0; i < limit; i++) {
      var p = sorted[i];
      if (p.name === pTop.name) continue;
      var loss = (1.0 - p.survivalProb) * p.dropoff;
      if (loss > maxLoss) {
        maxLoss = loss;
        pChallenger = p;
      }
    }
    if (!pChallenger && sorted.length > 1) {
      pChallenger = sorted[1];
    }

    var tradeoffs = {};
    var topNetGain = -999;
    var bestGTCandidate = null;

    for (var j = 0; j < availableRows.length; j++) {
      var cand = availableRows[j];
      var isTop = (cand.name === pTop.name);
      var refPlayer = isTop ? pChallenger : pTop;

      var netGain = 0;
      var ev2 = cand.adjVorp;
      var cmp = null;

      if (refPlayer) {
        var cmpPlayerA = isTop ? pTop : pTop;
        var cmpPlayerB = isTop ? pChallenger : cand;
        cmp = comparePlayersGameTheory(cmpPlayerA, cmpPlayerB, null, null, targetTurn, stdDev);

        if (cmp) {
          if (isTop) {
            // Picking pTop gives evOption2; net gain over challenger is -cmp.deltaEV
            ev2 = cmp.evOption2;
            netGain = -cmp.deltaEV;
          } else {
            // Picking candidate gives evOption1; net gain over pTop is cmp.deltaEV
            ev2 = cmp.evOption1;
            netGain = cmp.deltaEV;
          }
        }
      }

      if (!isTop && netGain > topNetGain) {
        topNetGain = netGain;
        bestGTCandidate = cand;
      }

      // Format plain-English advice & badge
      var badgeText = "";
      var badgeClass = "";
      var advice = "";

      var survPct = (cand.survivalProb * 100).toFixed(0) + "%";
      var cliffText = cand.dropoff > 0 ? ("+" + cand.dropoff.toFixed(1)) : "0.0";

      if (!isTop && netGain >= 2.0) {
        badgeText = "🏆 GT WINNER (+" + netGain.toFixed(1) + " EV)";
        badgeClass = "badge-gt-winner";
        advice = "Locks in " + cliffText + " " + cand.posLabel + " cliff. " + pTop.name +
          " (" + (pTop.survivalProb * 100).toFixed(0) + "% surv) is likely to slide to Turn #" + targetTurn +
          " (+" + netGain.toFixed(1) + " net EV advantage over drafting " + pTop.name + " now).";
      } else if (isTop) {
        if (pChallenger && netGain < -2.0) {
          badgeText = "🛡️ SAFE TO WAIT (" + survPct + " Surv)";
          badgeClass = "badge-wait";
          advice = pTop.name + " has " + survPct + " survival to Turn #" + targetTurn + " with a small " + cliffText +
            " cliff. Prioritizing " + pChallenger.name + " locks in their +" + pChallenger.dropoff.toFixed(1) +
            " cliff with +" + Math.abs(netGain).toFixed(1) + " net EV gain.";
        } else {
          badgeText = "🏆 TOP VALUE (VORP " + cand.adjVorp.toFixed(1) + ")";
          badgeClass = "badge-gt-winner";
          advice = "Locks in dominant overall board value (" + cand.adjVorp.toFixed(1) + " VORP). Miss him now and he will not survive to Turn #" + targetTurn + ".";
        }
      } else if (cand.action === "MUST REACH (Cliff)") {
        badgeText = "🚨 MUST REACH (" + cliffText + " Cliff)";
        badgeClass = "badge-must-reach";
        advice = "Critical cliff: only " + survPct + " survival to Turn #" + targetTurn + " with a " + cliffText +
          " dropoff. Passing forfeits irreplaceable tier value at " + cand.posLabel + ".";
      } else if (cand.action === "NOW OR NEVER") {
        badgeText = "⚡ NOW OR NEVER";
        badgeClass = "badge-now-or-never";
        advice = "High snipe risk: only " + survPct + " survival to Turn #" + targetTurn + ". Draft now if prioritizing " + cand.posLabel + " before opponents strike.";
      } else if (cand.survivalProb > 0.65) {
        badgeText = "🛡️ SAFE SLEEPER (" + survPct + " Surv)";
        badgeClass = "badge-wait";
        advice = "High survival (" + survPct + " to Turn #" + targetTurn + "). Let fall to your next turn; drafting now forfeits urgent cliff value.";
      } else {
        badgeText = "🎯 SOLID TARGET (" + cand.adjVorp.toFixed(1) + " VORP)";
        badgeClass = "badge-target";
        advice = "Steady " + cand.adjVorp.toFixed(1) + " VORP at " + cand.posLabel + ". Moderate survival (" + survPct + ") to Turn #" + targetTurn + ".";
      }

      tradeoffs[cand.name] = {
        name: cand.name,
        ev2: ev2,
        netGain: netGain,
        vsPlayer: refPlayer ? refPlayer.name : "",
        vsPos: refPlayer ? refPlayer.posLabel : "",
        vsSurv: refPlayer ? refPlayer.survivalProb : 0,
        badgeText: badgeText,
        badgeClass: badgeClass,
        advice: advice,
        cmp: cmp
      };
    }

    return {
      tradeoffs: tradeoffs,
      pTop: pTop,
      pChallenger: pChallenger,
      bestGTCandidate: bestGTCandidate,
      topNetGain: topNetGain
    };
  }

  /**
   * Identifies the primary strategic dilemma on the board for automated comparator display
   */
  function getTopMatchup(availableRows, targetTurn, stdDev) {
    var res = computeTargetTradeoffs(availableRows, targetTurn, stdDev);
    if (!res || !res.pTop) return null;

    var playerA = res.pTop;
    var playerB = (res.bestGTCandidate && res.topNetGain >= 2.0)
      ? res.bestGTCandidate
      : res.pChallenger;

    if (!playerB && availableRows.length > 1) {
      playerB = availableRows[1];
    }

    if (!playerA || !playerB) return null;

    var cmp = comparePlayersGameTheory(playerA, playerB, null, null, targetTurn, stdDev);
    return {
      playerA: playerA,
      playerB: playerB,
      cmp: cmp
    };
  }

  /**
   * Post-Draft Roster Grader & Surplus Value Recap
   *
   * Retroactive analysis once a draft has concluded:
   * 1. Total VORP captured vs expected value per draft slot
   *    (expected VORP at pick N = VORP of the Nth player on the ADP-ordered board).
   * 2. Best value steals: picks made well past a player's ADP (highest ADP Delta
   *    = ADP - pickNumber; positive means the drafter beat consensus).
   * 3. Positional balance summary of the grader's own roster vs roster limits,
   *    using the same C -> F flex rule as the live draft co-pilot.
   *
   * @param {Array}  pickHistory  [{ pickNumber, name, team, pos, isMine, timestamp }]
   * @param {Array}  players      master board rows (draft_data.json players)
   * @param {Object} options      { rosterLimits, teams, slot }
   */
  function gradeDraft(pickHistory, players, options) {
    options = options || {};
    var rosterLimits = options.rosterLimits || { C: 3, F: 5, D: 4, G: 2 };
    if (!pickHistory) pickHistory = [];
    if (!players) players = [];

    /* Player lookup by name */
    var byName = {};
    for (var i = 0; i < players.length; i++) {
      var pl = players[i];
      var nm = pl.name || pl.n;
      if (!nm) continue;
      var adpVal = (pl.adp && typeof pl.adp === "object")
        ? (pl.adp.yahoo || pl.adp.average || pl.adp.fantrax)
        : pl.adp;
      var adpNum = parseFloat(adpVal) || 999;
      var posArr = pl.pos || pl.p || [];
      byName[nm] = {
        name: nm,
        vorp: pl.vorp !== undefined ? pl.vorp : (pl.rawVorp || 0),
        adp: adpNum,
        pos: posArr,
        posLabel: pl.posLabel || posArr.join("/")
      };
    }

    /* Expected board: every player with a usable ADP, ordered by ADP */
    var board = [];
    for (var key in byName) {
      if (byName.hasOwnProperty(key) && byName[key].adp < 900) board.push(byName[key]);
    }
    board.sort(function (a, b) { return (a.adp - b.adp) || (b.vorp - a.vorp); });

    function expectedVorpAt(pickNumber) {
      if (!board.length || pickNumber < 1) return 0;
      var idx = Math.min(pickNumber, board.length) - 1;
      return board[idx].vorp;
    }

    /* Grade every recorded pick */
    var picks = [];
    var myPicks = [];
    var totalCaptured = 0;
    var totalExpected = 0;

    for (var p = 0; p < pickHistory.length; p++) {
      var h = pickHistory[p];
      var info = byName[h.name] || {
        vorp: 0,
        adp: 999,
        pos: h.pos || [],
        posLabel: (h.pos || []).join("/")
      };
      var expectedVorp = expectedVorpAt(h.pickNumber);
      var hasAdp = info.adp !== null && info.adp !== undefined && info.adp < 900;
      var adpDelta = hasAdp ? (info.adp - h.pickNumber) : 0;
      var surplus = info.vorp - expectedVorp;

      var entry = {
        pickNumber: h.pickNumber,
        name: h.name,
        team: h.team || "",
        pos: info.pos,
        posLabel: info.posLabel,
        isMine: !!h.isMine,
        vorp: info.vorp,
        adp: hasAdp ? info.adp : null,
        expectedVorp: expectedVorp,
        surplus: surplus,
        adpDelta: adpDelta
      };
      picks.push(entry);
      if (entry.isMine) {
        myPicks.push(entry);
        totalCaptured += entry.vorp;
        totalExpected += entry.expectedVorp;
      }
    }

    var totalSurplus = totalCaptured - totalExpected;
    var picksCount = myPicks.length;
    var avgSurplus = picksCount ? totalSurplus / picksCount : 0;
    var captureRatio = totalExpected > 0 ? totalCaptured / totalExpected : null;

    /* Letter grade from capture ratio (captured / expected) */
    var grade = null;
    var gradeLabel = "No picks recorded";
    if (picksCount > 0 && captureRatio !== null) {
      if (captureRatio >= 1.05) { grade = "A"; gradeLabel = "Elite draft - beat the board"; }
      else if (captureRatio >= 0.95) { grade = "B"; gradeLabel = "Solid draft - at or above expectation"; }
      else if (captureRatio >= 0.88) { grade = "C"; gradeLabel = "Average draft - roughly ADP-fair"; }
      else if (captureRatio >= 0.78) { grade = "D"; gradeLabel = "Below expectation - too many reaches"; }
      else { grade = "F"; gradeLabel = "Poor draft - significant value left behind"; }
    }

    /* Best value steals across the entire draft, ranked by ADP Delta.
     * Tiebreak on captured VORP so ordering is deterministic. */
    var steals = picks
      .filter(function (x) { return x.adpDelta > 0; })
      .sort(function (a, b) { return (b.adpDelta - a.adpDelta) || (b.vorp - a.vorp); })
      .slice(0, 10);


    /* Positional balance of my roster (mirrors app.js flex logic:
     * C-only and dual C,F players fill C first, then flex to F). */
    var counts = { C: 0, F: 0, D: 0, G: 0 };
    for (var m = 0; m < myPicks.length; m++) {
      var mp = myPicks[m];
      var positions = mp.pos || [];
      if (!positions.length) continue;
      if (positions.length === 1 && positions[0] === "C") {
        if (counts.C < (rosterLimits.C || 3)) counts.C++;
        else counts.F++;
      } else if (positions.indexOf("C") !== -1 && positions.indexOf("F") !== -1) {
        if (counts.C < (rosterLimits.C || 3)) counts.C++;
        else counts.F++;
      } else {
        for (var q = 0; q < positions.length; q++) {
          if (counts[positions[q]] !== undefined) counts[positions[q]]++;
        }
      }
    }

    var balanceSlots = [];
    var posOrder = ["C", "F", "D", "G"];
    var filledTotal = 0;
    var slotsTotal = 0;
    var hasEmpty = false;
    for (var b = 0; b < posOrder.length; b++) {
      var bp = posOrder[b];
      var bCount = counts[bp] || 0;
      var bLimit = rosterLimits[bp] || 0;
      var status;
      if (bCount === 0) { status = "EMPTY (critical)"; hasEmpty = true; }
      else if (bCount < bLimit) { status = "LIGHT"; }
      else if (bCount === bLimit) { status = "FILLED"; }
      else { status = "OVER"; }
      filledTotal += Math.min(bCount, bLimit);
      slotsTotal += bLimit;
      balanceSlots.push({ pos: bp, count: bCount, limit: bLimit, status: status });
    }

    var fillRatio = slotsTotal > 0 ? filledTotal / slotsTotal : null;
    var balanceVerdict;
    if (hasEmpty && picksCount > 0) balanceVerdict = "Unbalanced - at least one starting position empty";
    else if (fillRatio === null) balanceVerdict = "No roster to grade";
    else if (fillRatio >= 0.98) balanceVerdict = "Balanced - all starting slots filled";
    else balanceVerdict = "Mostly balanced - " + (slotsTotal - filledTotal) + " starting slot(s) still open";

    return {
      graded: picksCount > 0,
      picks: picks,
      myPicks: myPicks,
      summary: {
        totalCapturedVorp: totalCaptured,
        totalExpectedVorp: totalExpected,
        totalSurplus: totalSurplus,
        picksCount: picksCount,
        avgSurplusPerPick: avgSurplus,
        captureRatio: captureRatio,
        grade: grade,
        gradeLabel: gradeLabel
      },
      steals: steals,
      positionalBalance: {
        counts: counts,
        slots: balanceSlots,
        fillRatio: fillRatio,
        verdict: balanceVerdict
      }
    };
  }

  return {
    normalCDF: normalCDF,
    pSurvive: pSurvive,
    getNextSnakePick: getNextSnakePick,
    getPickDetails: getPickDetails,
    isMyTurn: isMyTurn,
    getCliffAlert: getCliffAlert,
    getDiminishingMultiplier: getDiminishingMultiplier,
    classifyAction: classifyAction,
    computeDynamicCliffs: computeDynamicCliffs,
    computeTargetTradeoffs: computeTargetTradeoffs,
    getTopMatchup: getTopMatchup,
    evaluateBoard: evaluateBoard,
    comparePlayersGameTheory: comparePlayersGameTheory,
    gradeDraft: gradeDraft
  };
});
