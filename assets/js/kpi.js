/* ============================================================
   kpi.js — KPI calculations and executive-summary generation
   ------------------------------------------------------------
   KPI 1  Sellout performance   (target vs actual vs balance)
   KPI 2  Unique Buying Accounts (UBA)
   KPI 3  Must Carry List compliance
   KPI 4  Promo product distribution

   Formulas (as specified):
     Achievement %        = Actual / Target * 100
     Balance              = Target - Actual
     Account compliance % = purchased required products / required products * 100
     Compliant account    = compliance % >= 85
     Compliance %         = compliant accounts / evaluated accounts * 100

   Accounts whose Channel + Product Class carries no required product
   list are EXCLUDED from compliance denominators (confirmed rule) and
   reported separately as "no target".
   ============================================================ */
(function (global) {
  'use strict';

  var D = global.CDOData;

  /* ---------------------------------------------------------- */
  /* Formatting                                                 */
  /* ---------------------------------------------------------- */
  function nf(n, dp) {
    if (!isFinite(n)) return '—';
    return Number(n).toLocaleString('en-PH', { minimumFractionDigits: dp || 0, maximumFractionDigits: dp || 0 });
  }
  function peso(n) { return '₱' + nf(Math.round(n || 0)); }
  function pesoShort(n) {
    var a = Math.abs(n || 0);
    if (a >= 1e9) return '₱' + nf(n / 1e9, 2) + 'B';
    if (a >= 1e6) return '₱' + nf(n / 1e6, 2) + 'M';
    if (a >= 1e3) return '₱' + nf(n / 1e3, 1) + 'K';
    return '₱' + nf(n, 0);
  }
  function pct(n, dp) { return (isFinite(n) ? nf(n, dp == null ? 1 : dp) : '—') + '%'; }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function tone(p) { return p >= 100 ? 'good' : (p >= 80 ? 'warn' : 'bad'); }

  /* ---------------------------------------------------------- */
  /* KPI 1 — Sellout performance                                */
  /* ---------------------------------------------------------- */
  function sellout(rows, dimKey) {
    var g = Object.create(null), order = [], i, r, k;
    for (i = 0; i < rows.length; i++) {
      r = rows[i];
      k = r[dimKey];
      if (D.isBlank(k)) k = '(Unassigned)';
      if (!g[k]) { g[k] = { label: k, target: 0, actual: 0 }; order.push(k); }
      g[k].target += r.__t;
      g[k].actual += r.__a;
    }
    var out = order.map(function (key) {
      var o = g[key];
      o.balance = o.target - o.actual;                  // signed: + = gap, - = overachievement
      o.balanceStack = Math.max(0, o.balance);          // stacked portion so Actual + Balance = Target
      o.ach = o.target > 0 ? (o.actual / o.target) * 100 : 0;
      o.hasTarget = o.target > 0;
      return o;
    });
    out.sort(function (a, b) { return b.target - a.target || b.actual - a.actual; });
    return out;
  }

  function selloutTotals(rows) {
    var t = 0, a = 0, i;
    for (i = 0; i < rows.length; i++) { t += rows[i].__t; a += rows[i].__a; }
    return { target: t, actual: a, balance: t - a, ach: t > 0 ? (a / t) * 100 : 0 };
  }

  /* ---------------------------------------------------------- */
  /* KPI 2 — Unique Buying Accounts                             */
  /* ---------------------------------------------------------- */
  /**
   * A buying account is a distinct customer whose CONSOLIDATED sales in the
   * scope are positive — one customer counts once however many invoices it has.
   */
  function ubaTotal(rows, custKey) {
    var sums = Object.create(null), i, c;
    for (i = 0; i < rows.length; i++) {
      c = rows[i][custKey];
      if (D.isBlank(c)) continue;
      sums[c] = (sums[c] || 0) + rows[i].__a;
    }
    var n = 0;
    for (c in sums) if (sums[c] > 0) n++;
    return n;
  }

  function ubaBy(rows, custKey, dimKey) {
    var cell = Object.create(null), i, r, k, c;
    for (i = 0; i < rows.length; i++) {
      r = rows[i]; c = r[custKey];
      if (D.isBlank(c)) continue;
      k = D.isBlank(r[dimKey]) ? '(Unassigned)' : r[dimKey];
      if (!cell[k]) cell[k] = Object.create(null);
      cell[k][c] = (cell[k][c] || 0) + r.__a;
    }
    var out = [];
    Object.keys(cell).forEach(function (k) {
      var n = 0, cs = cell[k];
      for (var c in cs) if (cs[c] > 0) n++;
      out.push({ label: k, uba: n });
    });
    out.sort(function (a, b) { return b.uba - a.uba; });
    return out;
  }

  /**
   * UBA per salesman per channel — the primary KPI 2 view.
   * Returns { rowLabels, colLabels, matrix[rowIdx][colIdx], rowTotals, colTotals, grand }
   */
  function ubaMatrix(rows, custKey, rowKey, colKey) {
    var cell = Object.create(null), rSet = Object.create(null), cSet = Object.create(null), i, r, rk, ck, c, key;
    for (i = 0; i < rows.length; i++) {
      r = rows[i]; c = r[custKey];
      if (D.isBlank(c)) continue;
      rk = D.isBlank(r[rowKey]) ? '(Unassigned)' : r[rowKey];
      ck = D.isBlank(r[colKey]) ? '(Unassigned)' : r[colKey];
      key = rk + '\u0001' + ck;
      if (!cell[key]) cell[key] = Object.create(null);
      cell[key][c] = (cell[key][c] || 0) + r.__a;
      rSet[rk] = 1; cSet[ck] = 1;
    }

    var counted = Object.create(null);            // key -> buying-account count
    Object.keys(cell).forEach(function (k) {
      var n = 0, cs = cell[k];
      for (var cc in cs) if (cs[cc] > 0) n++;
      counted[k] = n;
    });

    var rowLabels = Object.keys(rSet), colLabels = Object.keys(cSet);
    // order rows by total UBA desc, columns alphabetically for stable stacking
    var rowTot = Object.create(null);
    rowLabels.forEach(function (rl) {
      var t = 0; colLabels.forEach(function (cl) { t += counted[rl + '\u0001' + cl] || 0; });
      rowTot[rl] = t;
    });
    rowLabels.sort(function (a, b) { return rowTot[b] - rowTot[a] || String(a).localeCompare(String(b)); });
    colLabels.sort(function (a, b) { return String(a).localeCompare(String(b)); });

    var matrix = rowLabels.map(function (rl) {
      return colLabels.map(function (cl) { return counted[rl + '\u0001' + cl] || 0; });
    });
    var colTotals = colLabels.map(function (cl, j) {
      return matrix.reduce(function (s, row) { return s + row[j]; }, 0);
    });
    var rowTotals = rowLabels.map(function (rl) { return rowTot[rl]; });

    return {
      rowLabels: rowLabels, colLabels: colLabels, matrix: matrix,
      rowTotals: rowTotals, colTotals: colTotals,
      sumOfCells: rowTotals.reduce(function (a, b) { return a + b; }, 0),
      grand: ubaTotal(rows, custKey)
    };
  }

  /* ---------------------------------------------------------- */
  /* KPI 3 / 4 — Compliance (MCL and Promo share the method)    */
  /* ---------------------------------------------------------- */
  /**
   * Build per-account compliance units.
   * Unit = one customer account within one Product Class, because the
   * required product list is defined per Channel + Product Class.
   */
  function complianceUnits(rows, roles, reqIndex) {
    if (!reqIndex) return null;
    var custKey = roles.customercode || roles.customer;
    var custNameKey = roles.customer || roles.customercode;
    var pcKey = roles.productclass, chKey = roles.channel;
    var codeKey = roles.productcode || roles.product;
    var smKey = roles.salesman || roles.salesmancode;

    var units = Object.create(null), i, r, key, u;

    for (i = 0; i < rows.length; i++) {
      r = rows[i];
      var cust = r[custKey];
      if (D.isBlank(cust)) continue;
      var pc = String(r[pcKey] || '').trim();
      key = cust + '\u0001' + pc;
      u = units[key];
      if (!u) {
        u = units[key] = {
          customer: cust,
          customerName: r[custNameKey] || cust,
          productClass: pc,
          channelTally: Object.create(null),
          salesmanTally: Object.create(null),
          bought: Object.create(null)
        };
      }
      var ch = String(r[chKey] || '').trim();
      if (ch) u.channelTally[ch] = (u.channelTally[ch] || 0) + 1;
      var sm = String(r[smKey] || '').trim();
      if (sm) u.salesmanTally[sm] = (u.salesmanTally[sm] || 0) + 1;
      if (r.__a > 0) {
        var code = String(r[codeKey] || '').trim();
        if (code) u.bought[code] = 1;
      }
    }

    function dominant(tally) {
      var best = '', n = -1;
      for (var k in tally) if (tally[k] > n) { n = tally[k]; best = k; }
      return best;
    }

    var list = [];
    Object.keys(units).forEach(function (k) {
      var u = units[k];
      u.channel = dominant(u.channelTally);
      u.salesman = dominant(u.salesmanTally);
      var req = reqIndex.requiredFor(u.channel, u.productClass);
      var codes = req ? Object.keys(req) : [];
      u.required = codes.length;
      if (!u.required) {
        u.evaluated = false; u.purchased = 0; u.pct = null; u.compliant = false;
      } else {
        var hit = 0;
        for (var ci = 0; ci < codes.length; ci++) if (u.bought[codes[ci]]) hit++;
        u.purchased = hit;
        u.pct = (hit / u.required) * 100;
        u.compliant = u.pct >= D.CONFIG.complianceThreshold;
        u.evaluated = true;
      }
      list.push(u);
    });

    return list;
  }

  function complianceRollup(units, groupBy) {
    // groupBy: 'salesman' | 'channel' | 'productClass'
    var g = Object.create(null);
    units.forEach(function (u) {
      if (!u.evaluated) return;                       // channels without a target are excluded
      var k = u[groupBy] || '(Unassigned)';
      if (!g[k]) g[k] = { label: k, total: 0, compliant: 0, reqSum: 0, boughtSum: 0 };
      g[k].total++;
      if (u.compliant) g[k].compliant++;
      g[k].reqSum += u.required;
      g[k].boughtSum += u.purchased;
    });
    var out = Object.keys(g).map(function (k) {
      var o = g[k];
      o.pct = o.total > 0 ? (o.compliant / o.total) * 100 : 0;
      o.avgProductPct = o.reqSum > 0 ? (o.boughtSum / o.reqSum) * 100 : 0;
      return o;
    });
    out.sort(function (a, b) { return b.pct - a.pct || b.total - a.total; });
    return out;
  }

  function complianceOverall(units) {
    var evaluated = 0, compliant = 0, skipped = 0, reqSum = 0, boughtSum = 0;
    (units || []).forEach(function (u) {
      if (!u.evaluated) { skipped++; return; }
      evaluated++;
      if (u.compliant) compliant++;
      reqSum += u.required; boughtSum += u.purchased;
    });
    return {
      evaluated: evaluated, compliant: compliant, noTarget: skipped,
      pct: evaluated > 0 ? (compliant / evaluated) * 100 : 0,
      productPct: reqSum > 0 ? (boughtSum / reqSum) * 100 : 0,
      totalAccounts: evaluated + skipped
    };
  }

  /* ---------------------------------------------------------- */
  /* Executive summaries                                        */
  /* ---------------------------------------------------------- */
  function b(s) { return '<b>' + esc(s) + '</b>'; }
  function sig(p) { return '<span class="' + (p >= 100 ? 'up' : 'down') + '">' + pct(p) + '</span>'; }

  /** KPI 1 — sellout performance narrative */
  function summarySellout(series, dimLabel) {
    var withT = series.filter(function (s) { return s.hasTarget; });
    if (!withT.length) return '<p>No targets are set for the current selection, so achievement cannot be measured.</p>';

    var tot = withT.reduce(function (a, s) { return { target: a.target + s.target, actual: a.actual + s.actual }; }, { target: 0, actual: 0 });
    var overall = tot.target > 0 ? (tot.actual / tot.target) * 100 : 0;
    var gap = tot.target - tot.actual;

    var byAch = withT.slice().sort(function (a, b2) { return b2.ach - a.ach; });
    var bestAch = byAch[0], worstAch = byAch[byAch.length - 1];
    var byVol = withT.slice().sort(function (a, b2) { return b2.actual - a.actual; });
    var topVol = byVol[0], lowVol = byVol[byVol.length - 1];

    var over = withT.filter(function (s) { return s.ach >= 100; });
    var under = withT.filter(function (s) { return s.ach < 100; });
    var biggestGap = under.slice().sort(function (a, b2) { return (b2.target - b2.actual) - (a.target - a.actual); })[0];

    var p1 = '<p>' + b(bestAch.label) + ' delivered the highest achievement at ' + sig(bestAch.ach) +
      ' of target' + (byAch.length > 1 ? ', while ' + b(worstAch.label) + ' reached only ' + sig(worstAch.ach) : '') + '. ' +
      'Overall achievement across ' + withT.length + ' ' + esc(dimLabel.toLowerCase()) + (withT.length === 1 ? '' : 's') +
      ' stands at ' + sig(overall) + ', ' +
      (gap > 0 ? 'leaving a remaining gap of ' + b(peso(gap)) + ' versus target'
               : 'an overachievement of ' + b(peso(-gap)) + ' above target') + '.</p>';

    var p2 = '<p>' + b(topVol.label) + ' contributes the largest actual sellout at ' + b(pesoShort(topVol.actual)) +
      ' (' + pct(tot.actual > 0 ? topVol.actual / tot.actual * 100 : 0) + ' of the filtered total)' +
      (byVol.length > 1 ? ', against ' + b(pesoShort(lowVol.actual)) + ' from ' + b(lowVol.label) : '') + '. ' +
      over.length + ' of ' + withT.length + ' met or exceeded target' +
      (over.length ? ' (' + over.slice(0, 3).map(function (s) { return esc(s.label); }).join(', ') + (over.length > 3 ? ' and others' : '') + ')' : '') + '.</p>';

    var p3 = '';
    if (biggestGap) {
      p3 = '<p><b>Key opportunity:</b> closing the ' + b(peso(biggestGap.target - biggestGap.actual)) +
        ' shortfall at ' + b(biggestGap.label) + ' alone would lift overall achievement to ' +
        b(pct(tot.target > 0 ? (tot.actual + (biggestGap.target - biggestGap.actual)) / tot.target * 100 : 0)) + '. ' +
        (under.length > 1 ? b(under.length + ' of ' + withT.length) + ' are currently below target and account for ' +
          b(peso(under.reduce(function (a, s) { return a + (s.target - s.actual); }, 0))) + ' of the total gap.' : '') + '</p>';
    }
    return p1 + p2 + p3;
  }

  /** KPI 2 — UBA narrative */
  function summaryUBA(mx, rowLabel, colLabel) {
    if (!mx.rowLabels.length) return '<p>No buying accounts found for the current selection.</p>';

    var rows = mx.rowLabels.map(function (l, i) { return { label: l, n: mx.rowTotals[i] }; })
      .filter(function (x) { return x.n > 0; }).sort(function (a, b2) { return b2.n - a.n; });
    var cols = mx.colLabels.map(function (l, i) { return { label: l, n: mx.colTotals[i] }; })
      .filter(function (x) { return x.n > 0; }).sort(function (a, b2) { return b2.n - a.n; });

    if (!rows.length) return '<p>No accounts recorded positive consolidated sales for the current selection.</p>';

    var top = rows[0], low = rows[rows.length - 1];
    var topC = cols[0], lowC = cols[cols.length - 1];
    var avg = rows.reduce(function (a, x) { return a + x.n; }, 0) / rows.length;

    var p1 = '<p>Total unique buying accounts stand at ' + b(nf(mx.grand)) + ' across ' + rows.length + ' ' +
      esc(rowLabel.toLowerCase()) + (rows.length === 1 ? '' : 's') + ' and ' + cols.length + ' ' +
      esc(colLabel.toLowerCase()) + (cols.length === 1 ? '' : 's') + '. ' +
      b(top.label) + ' leads with ' + b(nf(top.n)) + ' buying accounts' +
      (rows.length > 1 ? ', while ' + b(low.label) + ' has the fewest at ' + b(nf(low.n)) : '') +
      ' (average ' + b(nf(avg, 1)) + ' per ' + esc(rowLabel.toLowerCase()) + ').</p>';

    var p2 = '<p>' + b(topC.label) + ' is the largest contributing ' + esc(colLabel.toLowerCase()) + ' with ' +
      b(nf(topC.n)) + ' accounts (' + pct(mx.sumOfCells > 0 ? topC.n / mx.sumOfCells * 100 : 0) + ' of coverage)' +
      (cols.length > 1 ? ', and ' + b(lowC.label) + ' the smallest at ' + b(nf(lowC.n)) : '') + '.</p>';

    var p3 = '';
    if (rows.length > 1) {
      var spread = top.n - low.n;
      p3 = '<p><b>Key opportunity:</b> the ' + b(nf(spread)) + '-account spread between ' + b(top.label) +
        ' and ' + b(low.label) + ' points to uneven coverage. Bringing every ' + esc(rowLabel.toLowerCase()) +
        ' up to the current average would add roughly ' +
        b(nf(Math.max(0, rows.reduce(function (a, x) { return a + Math.max(0, avg - x.n); }, 0)), 0)) +
        ' buying accounts.</p>';
    }
    if (mx.sumOfCells > mx.grand) {
      p3 += '<p class="hint">Note: stacked segments total ' + nf(mx.sumOfCells) + ' against ' + nf(mx.grand) +
        ' distinct accounts overall — ' + nf(mx.sumOfCells - mx.grand) + ' account' +
        (mx.sumOfCells - mx.grand === 1 ? ' is' : 's are') + ' served in more than one ' +
        esc(rowLabel.toLowerCase()) + '/' + esc(colLabel.toLowerCase()) + ' combination.</p>';
    }
    return p1 + p2 + p3;
  }

  /** KPI 3 / 4 — compliance narrative */
  function summaryCompliance(series, overall, dimLabel, kpiName) {
    if (!series.length) {
      return '<p>No accounts in the current selection have a required ' + esc(kpiName) +
        ' product list for their channel and product class, so compliance cannot be measured.</p>';
    }
    var best = series[0], worst = series[series.length - 1];
    var compliantGroups = series.filter(function (s) { return s.pct >= 100; });
    var weak = series.filter(function (s) { return s.pct < 50; });

    var p1 = '<p>Overall ' + esc(kpiName) + ' compliance is ' + b(pct(overall.pct)) + ' — ' +
      b(nf(overall.compliant)) + ' of ' + b(nf(overall.evaluated)) + ' evaluated accounts purchased at least ' +
      D.CONFIG.complianceThreshold + '% of their required products. ' +
      'At product level, ' + b(pct(overall.productPct)) + ' of all required product slots were filled.</p>';

    var p2 = '<p><b>Best performing ' + esc(dimLabel.toLowerCase()) + ':</b> ' + b(best.label) + ' at ' +
      b(pct(best.pct)) + ' (' + nf(best.compliant) + ' of ' + nf(best.total) + ' accounts)' +
      (series.length > 1 ? '. <b>Lowest:</b> ' + b(worst.label) + ' at ' + b(pct(worst.pct)) +
        ' (' + nf(worst.compliant) + ' of ' + nf(worst.total) + ')' : '') + '. ' +
      (compliantGroups.length ? b(compliantGroups.length) + ' of ' + series.length + ' reached full compliance.' : 'None reached full compliance.') + '</p>';

    var gapAccounts = overall.evaluated - overall.compliant;
    var p3 = '<p><b>Opportunity:</b> ' + b(nf(gapAccounts)) + ' account' + (gapAccounts === 1 ? '' : 's') +
      ' sit below the ' + D.CONFIG.complianceThreshold + '% threshold. ' +
      (weak.length ? 'Priority ' + esc(dimLabel.toLowerCase()) + (weak.length === 1 ? '' : 's') + ' below 50%: ' +
        b(weak.map(function (s) { return s.label; }).slice(0, 4).join(', ')) +
        (weak.length > 4 ? ' and ' + (weak.length - 4) + ' more' : '') + '. ' : '') +
      'Lifting every account to the threshold would move compliance to 100%.</p>';

    var p4 = '';
    if (overall.noTarget > 0) {
      p4 = '<p class="hint">' + nf(overall.noTarget) + ' account' + (overall.noTarget === 1 ? '' : 's') +
        ' had no required ' + esc(kpiName) + ' products for their channel and product class and are excluded from this calculation.</p>';
    }
    return p1 + p2 + p3 + p4;
  }

  global.CDOKpi = {
    nf: nf, peso: peso, pesoShort: pesoShort, pct: pct, esc: esc, tone: tone,
    sellout: sellout, selloutTotals: selloutTotals,
    ubaTotal: ubaTotal, ubaBy: ubaBy, ubaMatrix: ubaMatrix,
    complianceUnits: complianceUnits, complianceRollup: complianceRollup, complianceOverall: complianceOverall,
    summarySellout: summarySellout, summaryUBA: summaryUBA, summaryCompliance: summaryCompliance
  };
})(window);
