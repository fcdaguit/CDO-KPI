/* ============================================================
   ui.js — rendering, filters, charts, exports, auto-refresh
   ============================================================ */
(function (global) {
  'use strict';

  var D = global.CDOData, K = global.CDOKpi;
  var M = D.model;

  var state = {
    selections: {},      // dimKey -> [values]
    filtered: [],
    charts: {},          // id -> Chart instance
    drill: {},           // blockId -> drill value
    openPop: null,
    refreshTimer: null,
    building: false
  };

  var SERIES_COLORS = [
    '#3D58B2', '#2F8DCF', '#5FC2E8', '#1B3581', '#7E97EC', '#A6C8F0',
    '#12855B', '#34C58C', '#C9870A', '#E8B341', '#D92B2B', '#F06A6A',
    '#6D4C9F', '#9B7BC8', '#0E7490', '#47B5A5'
  ];

  /* ---------------------------------------------------------- */
  /* DOM helpers                                                */
  /* ---------------------------------------------------------- */
  function $(sel, root) { return (root || document).querySelector(sel); }
  function el(tag, cls, html) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (html != null) n.innerHTML = html;
    return n;
  }
  function isDark() { return document.documentElement.getAttribute('data-theme') === 'dark'; }
  function cssVar(name) { return getComputedStyle(document.documentElement).getPropertyValue(name).trim(); }

  function toast(msg) {
    var t = $('#toast');
    t.textContent = msg;
    t.classList.add('is-on');
    clearTimeout(toast._t);
    toast._t = setTimeout(function () { t.classList.remove('is-on'); }, 2600);
  }

  function store(key, val) {
    try { if (val === undefined) return localStorage.getItem(key); localStorage.setItem(key, val); }
    catch (e) { /* storage unavailable — non-fatal */ }
    return null;
  }

  /* ---------------------------------------------------------- */
  /* Theme                                                      */
  /* ---------------------------------------------------------- */
  function applyTheme(mode) {
    document.documentElement.setAttribute('data-theme', mode);
    store('cdo-theme', mode);
  }
  function initTheme() {
    var saved = store('cdo-theme');
    if (saved !== 'light' && saved !== 'dark') {
      saved = (global.matchMedia && global.matchMedia('(prefers-color-scheme: dark)').matches) ? 'dark' : 'light';
    }
    applyTheme(saved);
    $('#btnTheme').addEventListener('click', function () {
      applyTheme(isDark() ? 'light' : 'dark');
      renderAll();                       // charts need theme-aware axis colours
    });
  }

  /* ---------------------------------------------------------- */
  /* Notices                                                    */
  /* ---------------------------------------------------------- */
  function renderNotices() {
    var host = $('#notices');
    host.innerHTML = '';
    if (!M.notices || !M.notices.length) { host.hidden = true; return; }
    host.hidden = false;
    M.notices.forEach(function (n) {
      var icon = n.level === 'err' ? '✕' : (n.level === 'warn' ? '!' : 'i');
      var cls = 'notice ' + (n.level === 'err' ? 'notice--err' : n.level === 'info' ? 'notice--info' : '');
      var node = el('div', cls);
      node.appendChild(el('span', 'notice__icon', icon));
      node.appendChild(el('div', null, n.text));
      host.appendChild(node);
    });
  }

  /* ---------------------------------------------------------- */
  /* Filter bar                                                 */
  /* ---------------------------------------------------------- */
  function selOf(key) { return state.selections[key] || []; }

  function buttonLabel(dim) {
    var sel = selOf(dim.key);
    if (!sel.length) return 'All';
    if (sel.length === 1) return sel[0];
    return sel.length + ' selected';
  }

  function closePop() {
    if (state.openPop) {
      state.openPop.pop.classList.remove('is-open');
      state.openPop.btn.setAttribute('aria-expanded', 'false');
      state.openPop = null;
    }
  }

  function renderFilters() {
    var bar = $('#filterBar');
    bar.innerHTML = '';

    if (!M.dims.length) {
      bar.appendChild(el('p', 'pop__empty', 'No filterable dimensions detected in the data source.'));
      return;
    }

    M.dims.forEach(function (dim) {
      var fld = el('div', 'fld');
      var label = el('label', 'fld__label', K.esc(dim.label));
      var btn = el('button', 'fld__btn');
      btn.type = 'button';
      btn.setAttribute('aria-expanded', 'false');
      if (selOf(dim.key).length) btn.classList.add('is-filtered');
      btn.appendChild(el('span', 'fld__val', K.esc(buttonLabel(dim))));
      btn.appendChild(el('span', 'fld__caret', '▼'));

      var pop = el('div', 'pop');
      fld.appendChild(label); fld.appendChild(btn); fld.appendChild(pop);
      bar.appendChild(fld);

      btn.addEventListener('click', function (e) {
        e.stopPropagation();
        var wasOpen = pop.classList.contains('is-open');
        closePop();
        if (wasOpen) return;
        buildPop(dim, pop, btn);
        pop.classList.add('is-open');
        btn.setAttribute('aria-expanded', 'true');
        state.openPop = { pop: pop, btn: btn };
        var s = $('.pop__search', pop);
        if (s) s.focus();
      });
      pop.addEventListener('click', function (e) { e.stopPropagation(); });
    });

    // Row count + global export button
    var actions = $('#filters .panel__actions');
    if (!$('#btnExportAll')) {
      var bx = el('button', 'btn btn--sm btn--ghost', 'Export to Excel');
      bx.id = 'btnExportAll'; bx.type = 'button';
      bx.addEventListener('click', exportWorkbook);
      actions.insertBefore(bx, $('#btnResetAll'));
    }
  }

  function buildPop(dim, pop, btn) {
    pop.innerHTML = '';
    var opts = D.optionsFor(dim, state.selections);

    if (dim.values.length > 8) {
      var search = el('input', 'pop__search');
      search.type = 'search';
      search.placeholder = 'Search ' + dim.label + '…';
      search.addEventListener('input', function () { paint(search.value); });
      pop.appendChild(search);
    }

    var tools = el('div', 'pop__tools');
    var bAll = el('button', 'btn btn--sm btn--ghost', 'Select all');
    var bNone = el('button', 'btn btn--sm btn--ghost', 'Uncheck all');
    bAll.type = 'button'; bNone.type = 'button';
    bAll.addEventListener('click', function () {
      state.selections[dim.key] = opts.map(function (o) { return o.value; });
      refreshFilterUI(dim, pop, btn); onFilterChange();
    });
    bNone.addEventListener('click', function () {
      state.selections[dim.key] = [];
      refreshFilterUI(dim, pop, btn); onFilterChange();
    });
    tools.appendChild(bAll); tools.appendChild(bNone);
    pop.appendChild(tools);

    var list = el('div', 'pop__list');
    pop.appendChild(list);

    function paint(q) {
      list.innerHTML = '';
      var needle = (q || '').toLowerCase();
      var shown = opts.filter(function (o) { return !needle || String(o.value).toLowerCase().indexOf(needle) >= 0; });
      if (!shown.length) { list.appendChild(el('p', 'pop__empty', 'No matching values')); return; }
      shown.slice(0, 400).forEach(function (o) {
        var row = el('label', 'opt');
        var cb = el('input'); cb.type = 'checkbox';
        cb.checked = selOf(dim.key).indexOf(o.value) >= 0;
        cb.addEventListener('change', function () {
          var cur = selOf(dim.key).slice();
          var ix = cur.indexOf(o.value);
          if (cb.checked && ix < 0) cur.push(o.value);
          if (!cb.checked && ix >= 0) cur.splice(ix, 1);
          state.selections[dim.key] = cur;
          refreshFilterUI(dim, pop, btn);
          onFilterChange();
        });
        row.appendChild(cb);
        row.appendChild(el('span', 'opt__txt', K.esc(o.value)));
        row.appendChild(el('span', 'opt__n', K.nf(o.count)));
        list.appendChild(row);
      });
    }
    paint('');
    pop._paint = paint;
  }

  function refreshFilterUI(dim, pop, btn) {
    var sel = selOf(dim.key);
    $('.fld__val', btn).textContent = buttonLabel(dim);
    btn.classList.toggle('is-filtered', sel.length > 0);
  }

  /** Rebuild every closed dropdown's button label (selections may have been cleared). */
  function syncFilterButtons() {
    var flds = document.querySelectorAll('#filterBar .fld');
    M.dims.forEach(function (dim, i) {
      var fld = flds[i];
      if (!fld) return;
      var btn = $('.fld__btn', fld);
      $('.fld__val', btn).textContent = buttonLabel(dim);
      btn.classList.toggle('is-filtered', selOf(dim.key).length > 0);
    });
  }

  function onFilterChange() {
    // Drop selections that the cascade has made unreachable.
    M.dims.forEach(function (dim) {
      var sel = selOf(dim.key);
      if (!sel.length) return;
      var reachable = D.optionsFor(dim, state.selections).map(function (o) { return o.value; });
      var kept = sel.filter(function (v) { return reachable.indexOf(v) >= 0; });
      if (kept.length !== sel.length) state.selections[dim.key] = kept;
    });
    syncFilterButtons();
    state.drill = {};
    renderAll();
  }

  /* ---------------------------------------------------------- */
  /* Summary cards                                              */
  /* ---------------------------------------------------------- */
  function card(label, value, sub, accent, pill) {
    var c = el('div', 'card');
    c.style.setProperty('--accent', accent);
    c.appendChild(el('div', 'card__label', K.esc(label)));
    c.appendChild(el('div', 'card__value', value));
    if (sub) c.appendChild(el('div', 'card__sub', sub));
    if (pill) c.appendChild(el('span', 'card__pill pill--' + pill.tone, K.esc(pill.text)));
    return c;
  }

  function renderCards(ctx) {
    var host = $('#summaryCards');
    host.innerHTML = '';
    var t = ctx.totals;

    host.appendChild(card('Total Sellout Target', K.pesoShort(t.target), K.peso(t.target), 'var(--c-target)'));
    host.appendChild(card('Total Sellout Actual', K.pesoShort(t.actual), K.peso(t.actual), 'var(--c-actual)'));
    host.appendChild(card('Overall Achievement', K.pct(t.ach), (t.balance >= 0 ? 'Gap ' + K.pesoShort(t.balance) : 'Over by ' + K.pesoShort(-t.balance)),
      'var(--fast-accent)', { tone: K.tone(t.ach), text: t.ach >= 100 ? 'On / above target' : 'Below target' }));
    host.appendChild(card('Unique Buying Accounts', K.nf(ctx.uba), ctx.ubaDenom ? 'of ' + K.nf(ctx.ubaDenom) + ' accounts in scope' : null,
      'var(--c-good)', ctx.ubaDenom ? { tone: K.tone(ctx.uba / ctx.ubaDenom * 100), text: K.pct(ctx.uba / ctx.ubaDenom * 100) + ' buying' } : null));

    var mcl = ctx.mclOverall, promo = ctx.promoOverall;
    host.appendChild(card('MCL Compliance', mcl ? K.pct(mcl.pct) : '—',
      mcl ? K.nf(mcl.compliant) + ' of ' + K.nf(mcl.evaluated) + ' accounts ≥ 85%' : 'No MCL list available',
      'var(--fast-primary)', mcl ? { tone: K.tone(mcl.pct), text: K.pct(mcl.productPct) + ' of product slots' } : null));
    host.appendChild(card('Promo Distribution', promo ? K.pct(promo.pct) : '—',
      promo ? K.nf(promo.compliant) + ' of ' + K.nf(promo.evaluated) + ' accounts ≥ 85%' : 'No promo list available',
      'var(--fast-navy)', promo ? { tone: K.tone(promo.pct), text: K.pct(promo.productPct) + ' of product slots' } : null));
  }

  /* ---------------------------------------------------------- */
  /* Generic chart block                                        */
  /* ---------------------------------------------------------- */
  function block(opts) {
    // opts: {id, title, meta, drillNote, onBack, exportRows, exportName, build(canvas), summaryHTML, empty}
    var b = el('div', 'block');
    var head = el('div', 'block__head');
    var left = el('div');
    left.appendChild(el('h3', 'block__title', K.esc(opts.title)));
    if (opts.meta) left.appendChild(el('p', 'block__meta', opts.meta));
    head.appendChild(left);

    var tools = el('div', 'block__tools');
    if (!opts.empty) {
      var png = el('button', 'btn btn--sm btn--ghost', 'PNG');
      png.type = 'button';
      png.addEventListener('click', function () { exportPNG(opts.id, opts.exportName || opts.title); });
      tools.appendChild(png);

      var xls = el('button', 'btn btn--sm btn--ghost', 'Excel');
      xls.type = 'button';
      xls.addEventListener('click', function () { exportSheet(opts.exportRows || [], opts.exportName || opts.title); });
      tools.appendChild(xls);
    }
    head.appendChild(tools);
    b.appendChild(head);

    if (opts.drillChip) {
      var drill = el('div', 'drill');
      drill.appendChild(el('span', null, 'Drill-down:'));
      drill.appendChild(el('span', 'drill__chip', K.esc(opts.drillChip)));
      var back = el('button', 'drill__back', '← back to all');
      back.type = 'button';
      back.addEventListener('click', opts.onBack);
      drill.appendChild(back);
      b.appendChild(drill);
    } else if (opts.drillNote) {
      var hint = el('div', 'drill');
      hint.appendChild(el('span', 'hint', opts.drillNote));
      b.appendChild(hint);
    }

    var body = el('div', 'block__body');
    if (opts.empty) {
      body.appendChild(el('p', 'block__empty', opts.empty));
    } else if (opts.tableHTML) {
      body.innerHTML = opts.tableHTML;
    } else {
      var wrap = el('div', 'chartwrap' + (opts.tall ? ' chartwrap--tall' : ''));
      var cv = el('canvas');
      cv.id = 'cv-' + opts.id;
      wrap.appendChild(cv);
      body.appendChild(wrap);
    }
    b.appendChild(body);

    if (opts.summaryHTML) {
      var ex = el('div', 'exec');
      ex.appendChild(el('div', 'exec__h', 'Executive Summary'));
      ex.appendChild(el('div', null, opts.summaryHTML));
      b.appendChild(ex);
    }
    return b;
  }

  function destroyChart(id) {
    if (state.charts[id]) { state.charts[id].destroy(); delete state.charts[id]; }
  }

  /* Chart.js shared styling -------------------------------------------- */
  function gridColor() { return isDark() ? 'rgba(255,255,255,.08)' : 'rgba(27,53,129,.08)'; }
  function tickColor() { return isDark() ? '#A6AFC2' : '#5A6479'; }

  function baseOptions(valueFmt) {
    return {
      responsive: true,
      maintainAspectRatio: false,
      animation: { duration: 650, easing: 'easeOutQuart' },
      interaction: { mode: 'index', intersect: false },
      layout: { padding: { top: 26, right: 6, bottom: 0, left: 0 } },
      plugins: {
        legend: {
          position: 'top', align: 'end',
          labels: { boxWidth: 11, boxHeight: 11, usePointStyle: true, pointStyle: 'rectRounded',
                    color: tickColor(), font: { family: 'Poppins', size: 12 }, padding: 14 }
        },
        tooltip: {
          backgroundColor: isDark() ? '#0D1117' : '#1B3581',
          titleFont: { family: 'Poppins', size: 13, weight: '600' },
          bodyFont: { family: 'Poppins', size: 12.5 },
          padding: 11, cornerRadius: 8, displayColors: true, boxPadding: 4
        }
      },
      scales: {
        x: {
          grid: { display: false, drawBorder: false },
          ticks: { color: tickColor(), font: { family: 'Poppins', size: 11.5 }, maxRotation: 36, minRotation: 0, autoSkip: false,
                   callback: function (v) { var l = this.getLabelForValue(v); return String(l).length > 22 ? String(l).slice(0, 21) + '…' : l; } }
        },
        y: {
          beginAtZero: true,
          grid: { color: gridColor(), drawBorder: false },
          ticks: { color: tickColor(), font: { family: 'Poppins', size: 11.5 },
                   callback: function (v) { return valueFmt ? valueFmt(v) : v; } }
        }
      }
    };
  }

  /* Plugin: draw a label above each category group ---------------------- */
  var topLabelPlugin = {
    id: 'cdoTopLabels',
    afterDatasetsDraw: function (chart, args, pluginOpts) {
      var cfg = pluginOpts || {};
      var labels = cfg.labels;
      if (!labels || !labels.length) return;
      var ctx = chart.ctx;
      var count = chart.data.labels.length;
      ctx.save();
      ctx.font = '600 11.5px Poppins, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'bottom';
      for (var i = 0; i < count; i++) {
        if (labels[i] == null || labels[i] === '') continue;
        var minY = Infinity, sumX = 0, nBars = 0;
        chart.data.datasets.forEach(function (ds, di) {
          var meta = chart.getDatasetMeta(di);
          if (meta.hidden) return;
          var bar = meta.data[i];
          if (!bar) return;
          // top of a stack: use the bar's own y
          if (bar.y < minY) minY = bar.y;
          sumX += bar.x; nBars++;
        });
        if (!nBars || !isFinite(minY)) continue;
        ctx.fillStyle = (cfg.colors && cfg.colors[i]) || tickColor();
        ctx.fillText(String(labels[i]), sumX / nBars, Math.max(12, minY - 7));
      }
      ctx.restore();
    }
  };
  if (global.Chart) Chart.register(topLabelPlugin);

  /* ---------------------------------------------------------- */
  /* KPI 1 — Sellout charts                                     */
  /* ---------------------------------------------------------- */
  function buildSelloutBlock(host, id, title, dim, rows) {
    var series = K.sellout(rows, dim.key);
    var hostEl = host;

    if (!series.length) {
      hostEl.appendChild(block({ id: id, title: title, empty: 'No data for the current filter selection.' }));
      return;
    }

    var MAXBARS = 18;
    var trimmed = series.length > MAXBARS;
    var shown = trimmed ? series.slice(0, MAXBARS) : series;

    var exportRows = series.map(function (s) {
      return {
        [dim.label]: s.label,
        'Target': Math.round(s.target),
        'Actual': Math.round(s.actual),
        'Balance': Math.round(s.balance),
        'Achievement %': Number(s.ach.toFixed(2))
      };
    });

    var b = block({
      id: id,
      title: title,
      meta: shown.length + ' of ' + series.length + ' ' + dim.label.toLowerCase() + (series.length === 1 ? '' : 's') +
            (trimmed ? ' (top ' + MAXBARS + ' by target)' : '') +
            ' · Target ' + K.pesoShort(series.reduce(function (a, s) { return a + s.target; }, 0)) +
            ' · Actual ' + K.pesoShort(series.reduce(function (a, s) { return a + s.actual; }, 0)),
      exportRows: exportRows,
      exportName: title,
      summaryHTML: K.summarySellout(series, dim.label),
      tall: shown.length > 10
    });
    hostEl.appendChild(b);

    var cv = $('#cv-' + id);
    destroyChart(id);
    var achLabels = shown.map(function (s) { return s.hasTarget ? K.pct(s.ach, s.ach >= 10 ? 0 : 1) : ''; });
    var achColors = shown.map(function (s) {
      return s.ach >= 100 ? cssVar('--c-good') : (s.ach >= 80 ? cssVar('--c-warn') : cssVar('--c-bad'));
    });

    state.charts[id] = new Chart(cv, {
      type: 'bar',
      data: {
        labels: shown.map(function (s) { return s.label; }),
        datasets: [
          { label: 'Target', data: shown.map(function (s) { return s.target; }),
            backgroundColor: cssVar('--c-target'), stack: 'target', borderRadius: 4, maxBarThickness: 46 },
          { label: 'Actual', data: shown.map(function (s) { return s.actual; }),
            backgroundColor: cssVar('--c-actual'), stack: 'av', borderRadius: { topLeft: 0, topRight: 0 }, maxBarThickness: 46 },
          { label: 'Balance', data: shown.map(function (s) { return s.balanceStack; }),
            backgroundColor: cssVar('--c-balance'), stack: 'av', borderRadius: 4, maxBarThickness: 46 }
        ]
      },
      options: Object.assign(baseOptions(K.pesoShort), {
        scales: Object.assign(baseOptions(K.pesoShort).scales, {
          x: Object.assign(baseOptions().scales.x, { stacked: true }),
          y: Object.assign(baseOptions(K.pesoShort).scales.y, { stacked: true })
        }),
        plugins: Object.assign(baseOptions().plugins, {
          cdoTopLabels: { labels: achLabels, colors: achColors },
          tooltip: Object.assign(baseOptions().plugins.tooltip, {
            callbacks: {
              label: function (c) { return c.dataset.label + ': ' + K.peso(c.parsed.y); },
              afterBody: function (items) {
                var s = shown[items[0].dataIndex];
                return ['Achievement: ' + K.pct(s.ach),
                        (s.balance >= 0 ? 'Gap to target: ' + K.peso(s.balance) : 'Over target by: ' + K.peso(-s.balance))];
              }
            }
          })
        })
      })
    });
  }

  /* ---------------------------------------------------------- */
  /* KPI 2 — UBA                                                */
  /* ---------------------------------------------------------- */
  function buildUBABlock(host, rows, ctx) {
    var roles = M.roles;
    var custKey = roles.customercode || roles.customer;
    var smDim = dimByRole('salesman') || dimByRole('salesmancode');
    var chDim = dimByRole('channel');

    if (!custKey || !smDim || !chDim) {
      host.appendChild(block({ id: 'uba', title: 'UBA per Salesman per Channel',
        empty: 'Needs customer, salesperson and channel columns in the data source.' }));
      return;
    }

    var id = 'uba';
    var drillVal = state.drill[id];
    var scopeRows = rows;
    if (drillVal) scopeRows = rows.filter(function (r) { return r[smDim.key] === drillVal; });

    var mx = K.ubaMatrix(scopeRows, custKey, drillVal ? chDim.key : smDim.key, drillVal ? smDim.key : chDim.key);

    if (!mx.rowLabels.length) {
      host.appendChild(block({ id: id, title: 'UBA per Salesman per Channel', empty: 'No buying accounts for the current selection.' }));
      return;
    }

    var exportRows = [];
    mx.rowLabels.forEach(function (rl, i) {
      mx.colLabels.forEach(function (cl, j) {
        if (mx.matrix[i][j] > 0) {
          exportRows.push({
            [drillVal ? chDim.label : smDim.label]: rl,
            [drillVal ? smDim.label : chDim.label]: cl,
            'Unique Buying Accounts': mx.matrix[i][j]
          });
        }
      });
      exportRows.push({ [drillVal ? chDim.label : smDim.label]: rl, [drillVal ? smDim.label : chDim.label]: 'TOTAL', 'Unique Buying Accounts': mx.rowTotals[i] });
    });

    var b = block({
      id: id,
      title: drillVal ? 'UBA by Channel — ' + drillVal : 'UBA per Salesman per Channel',
      meta: K.nf(mx.grand) + ' distinct buying accounts · ' + mx.rowLabels.length + ' ' +
            (drillVal ? chDim.label.toLowerCase() : smDim.label.toLowerCase()) + 's · stacked by ' +
            (drillVal ? smDim.label.toLowerCase() : chDim.label.toLowerCase()),
      drillChip: drillVal || null,
      drillNote: drillVal ? null : 'Click a bar to drill into that ' + smDim.label.toLowerCase() + '.',
      onBack: function () { state.drill[id] = null; renderAll(); },
      exportRows: exportRows,
      exportName: 'UBA per Salesman per Channel',
      summaryHTML: K.summaryUBA(mx, drillVal ? chDim.label : smDim.label, drillVal ? smDim.label : chDim.label),
      tall: mx.rowLabels.length > 10
    });
    host.appendChild(b);

    var cv = $('#cv-' + id);
    destroyChart(id);
    var datasets = mx.colLabels.map(function (cl, j) {
      return {
        label: cl,
        data: mx.matrix.map(function (row) { return row[j]; }),
        backgroundColor: SERIES_COLORS[j % SERIES_COLORS.length],
        stack: 'uba', borderRadius: 3, maxBarThickness: 52
      };
    });

    state.charts[id] = new Chart(cv, {
      type: 'bar',
      data: { labels: mx.rowLabels, datasets: datasets },
      options: Object.assign(baseOptions(K.nf), {
        scales: {
          x: Object.assign(baseOptions().scales.x, { stacked: true }),
          y: Object.assign(baseOptions(K.nf).scales.y, { stacked: true, title: { display: true, text: 'Unique buying accounts', color: tickColor(), font: { family: 'Poppins', size: 11.5 } } })
        },
        plugins: Object.assign(baseOptions().plugins, {
          cdoTopLabels: { labels: mx.rowTotals.map(function (n) { return K.nf(n); }) },
          tooltip: Object.assign(baseOptions().plugins.tooltip, {
            callbacks: {
              label: function (c) { return c.dataset.label + ': ' + K.nf(c.parsed.y) + ' account' + (c.parsed.y === 1 ? '' : 's'); },
              afterBody: function (items) { return ['Total: ' + K.nf(mx.rowTotals[items[0].dataIndex]) + ' accounts']; }
            }
          })
        }),
        onClick: function (evt, elems) {
          if (drillVal || !elems.length) return;
          state.drill[id] = mx.rowLabels[elems[0].index];
          renderAll();
        }
      })
    });

    // Secondary view: UBA by channel overall
    var byCh = K.ubaBy(rows, custKey, chDim.key);
    var id2 = 'ubaCh';
    var b2 = block({
      id: id2,
      title: 'UBA Contribution by ' + chDim.label,
      meta: byCh.length + ' ' + chDim.label.toLowerCase() + 's in scope',
      exportRows: byCh.map(function (x) { return { [chDim.label]: x.label, 'Unique Buying Accounts': x.uba }; }),
      exportName: 'UBA by ' + chDim.label,
      summaryHTML: null
    });
    host.appendChild(b2);
    destroyChart(id2);
    state.charts[id2] = new Chart($('#cv-' + id2), {
      type: 'bar',
      data: {
        labels: byCh.map(function (x) { return x.label; }),
        datasets: [{ label: 'Unique Buying Accounts', data: byCh.map(function (x) { return x.uba; }),
                     backgroundColor: byCh.map(function (x, i) { return SERIES_COLORS[i % SERIES_COLORS.length]; }),
                     borderRadius: 4, maxBarThickness: 54 }]
      },
      options: Object.assign(baseOptions(K.nf), {
        plugins: Object.assign(baseOptions().plugins, {
          legend: { display: false },
          cdoTopLabels: { labels: byCh.map(function (x) { return K.nf(x.uba); }) },
          tooltip: Object.assign(baseOptions().plugins.tooltip, {
            callbacks: { label: function (c) { return K.nf(c.parsed.y) + ' unique buying accounts'; } }
          })
        })
      })
    });
  }

  /* ---------------------------------------------------------- */
  /* KPI 3 / 4 — Compliance charts                              */
  /* ---------------------------------------------------------- */
  function buildComplianceBlocks(host, units, overall, kpiName, prefix) {
    if (!units) {
      host.appendChild(block({ id: prefix + 'na', title: kpiName + ' Compliance',
        empty: 'No ' + kpiName + ' product list found in the workbook.' }));
      return;
    }

    var views = [
      { role: 'salesman', group: 'salesman', title: kpiName + ' Compliance per Salesman' },
      { role: 'channel', group: 'channel', title: kpiName + ' Compliance per Channel' },
      { role: 'productclass', group: 'productClass', title: kpiName + ' Compliance per Product Class' }
    ];

    views.forEach(function (v, vi) {
      var id = prefix + v.group;
      var drillVal = state.drill[id];

      if (drillVal) {
        // Drill-down: account-level detail for the selected group
        var detail = units.filter(function (u) { return u.evaluated && (u[v.group] || '(Unassigned)') === drillVal; })
          .sort(function (a, b2) { return b2.pct - a.pct; });
        var rowsHTML = detail.slice(0, 200).map(function (u) {
          var t = u.compliant ? 'good' : (u.pct >= 50 ? 'warn' : 'bad');
          return '<tr><td>' + K.esc(u.customerName) + '</td><td>' + K.esc(u.productClass) + '</td><td>' + K.esc(u.channel) +
            '</td><td style="text-align:right">' + u.purchased + ' / ' + u.required +
            '</td><td style="text-align:right"><span class="card__pill pill--' + t + '">' + K.pct(u.pct) + '</span></td></tr>';
        }).join('');
        var tableHTML =
          '<div style="overflow:auto;max-height:430px"><table style="width:100%;border-collapse:collapse;font-size:13px">' +
          '<thead><tr style="text-align:left;position:sticky;top:0;background:var(--surface-2)">' +
          '<th style="padding:9px 10px">Account</th><th style="padding:9px 10px">Class</th><th style="padding:9px 10px">Channel</th>' +
          '<th style="padding:9px 10px;text-align:right">Purchased / Required</th><th style="padding:9px 10px;text-align:right">Compliance</th>' +
          '</tr></thead><tbody>' + rowsHTML + '</tbody></table>' +
          (detail.length > 200 ? '<p class="hint" style="padding:10px">Showing first 200 of ' + K.nf(detail.length) + ' accounts — use Excel export for the full list.</p>' : '') +
          '</div>';

        host.appendChild(block({
          id: id, title: v.title + ' — ' + drillVal,
          meta: K.nf(detail.length) + ' evaluated accounts · ' + K.nf(detail.filter(function (u) { return u.compliant; }).length) + ' compliant',
          drillChip: drillVal,
          onBack: function () { state.drill[id] = null; renderAll(); },
          exportRows: detail.map(function (u) {
            return { 'Account': u.customerName, 'Product Class': u.productClass, 'Channel': u.channel,
                     'Required': u.required, 'Purchased': u.purchased, 'Compliance %': Number(u.pct.toFixed(2)),
                     'Compliant': u.compliant ? 'Yes' : 'No' };
          }),
          exportName: v.title + ' - ' + drillVal,
          tableHTML: tableHTML
        }));
        return;
      }

      var series = K.complianceRollup(units, v.group);
      if (!series.length) {
        host.appendChild(block({ id: id, title: v.title, empty: 'No accounts with a required ' + kpiName + ' list in this selection.' }));
        return;
      }

      var MAXBARS = 18;
      var shown = series.length > MAXBARS ? series.slice(0, MAXBARS) : series;

      host.appendChild(block({
        id: id, title: v.title,
        meta: K.nf(overall.compliant) + ' of ' + K.nf(overall.evaluated) + ' accounts compliant overall (' + K.pct(overall.pct) + ')' +
              (overall.noTarget ? ' · ' + K.nf(overall.noTarget) + ' excluded (no required list)' : ''),
        drillNote: 'Click a bar to list the accounts behind it.',
        exportRows: series.map(function (s) {
          return { [v.title.indexOf('Salesman') >= 0 ? 'Salesman' : v.title.indexOf('Channel') >= 0 ? 'Channel' : 'Product Class']: s.label,
                   'Accounts Evaluated': s.total, 'Compliant Accounts': s.compliant,
                   'Compliance %': Number(s.pct.toFixed(2)), 'Product Slots Filled %': Number(s.avgProductPct.toFixed(2)) };
        }),
        exportName: v.title,
        summaryHTML: K.summaryCompliance(series, overall, v.group === 'productClass' ? 'Product Class' : v.group, kpiName),
        tall: shown.length > 10
      }));

      var cv = $('#cv-' + id);
      destroyChart(id);
      state.charts[id] = new Chart(cv, {
        type: 'bar',
        data: {
          labels: shown.map(function (s) { return s.label; }),
          datasets: [{
            label: 'Compliance %',
            data: shown.map(function (s) { return Number(s.pct.toFixed(2)); }),
            backgroundColor: shown.map(function (s) {
              return s.pct >= 100 ? cssVar('--c-good') : (s.pct >= D.CONFIG.complianceThreshold ? cssVar('--fast-primary') : (s.pct >= 50 ? cssVar('--c-warn') : cssVar('--c-bad')));
            }),
            borderRadius: 4, maxBarThickness: 50
          }]
        },
        options: Object.assign(baseOptions(function (v2) { return v2 + '%'; }), {
          scales: {
            x: baseOptions().scales.x,
            y: Object.assign(baseOptions(function (v2) { return v2 + '%'; }).scales.y, { max: 100, title: { display: true, text: '% of accounts compliant', color: tickColor(), font: { family: 'Poppins', size: 11.5 } } })
          },
          plugins: Object.assign(baseOptions().plugins, {
            legend: { display: false },
            cdoTopLabels: { labels: shown.map(function (s) { return K.pct(s.pct, s.pct >= 10 ? 0 : 1); }) },
            tooltip: Object.assign(baseOptions().plugins.tooltip, {
              callbacks: {
                label: function (c) { return K.pct(c.parsed.y) + ' compliant'; },
                afterBody: function (items) {
                  var s = shown[items[0].dataIndex];
                  return [K.nf(s.compliant) + ' of ' + K.nf(s.total) + ' accounts ≥ ' + D.CONFIG.complianceThreshold + '%',
                          'Product slots filled: ' + K.pct(s.avgProductPct)];
                }
              }
            })
          }),
          onClick: function (evt, elems) {
            if (!elems.length) return;
            state.drill[id] = shown[elems[0].index].label;
            renderAll();
          }
        })
      });
    });
  }

  /* ---------------------------------------------------------- */
  /* Exports                                                    */
  /* ---------------------------------------------------------- */
  function exportPNG(id, name) {
    var ch = state.charts[id];
    if (!ch) { toast('Nothing to export here'); return; }
    var src = ch.canvas;
    var out = document.createElement('canvas');
    out.width = src.width; out.height = src.height;
    var cx = out.getContext('2d');
    cx.fillStyle = isDark() ? '#161B26' : '#FFFFFF';
    cx.fillRect(0, 0, out.width, out.height);
    cx.drawImage(src, 0, 0);
    var a = document.createElement('a');
    a.href = out.toDataURL('image/png');
    a.download = safeName(name) + '.png';
    a.click();
    toast('Chart exported as PNG');
  }

  function safeName(s) {
    return String(s).replace(/[^\w\s-]/g, '').replace(/\s+/g, '_').slice(0, 60) || 'export';
  }

  function sheetName(s) {
    return String(s).replace(/[\\\/\?\*\[\]:]/g, '-').slice(0, 31) || 'Sheet';
  }

  function exportSheet(rows, name) {
    if (!rows || !rows.length) { toast('No rows to export'); return; }
    if (global.XLSX) {
      var wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rows), sheetName(name));
      XLSX.writeFile(wb, safeName(name) + '.xlsx');
      toast('Exported ' + rows.length + ' rows to Excel');
    } else {
      downloadCSV(rows, safeName(name) + '.csv');
      toast('Excel library unavailable — exported CSV instead');
    }
  }

  function downloadCSV(rows, filename) {
    var cols = Object.keys(rows[0]);
    var q = function (v) { var s = String(v == null ? '' : v); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
    var csv = cols.join(',') + '\n' + rows.map(function (r) { return cols.map(function (c) { return q(r[c]); }).join(','); }).join('\n');
    var blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 1500);
  }

  /** Full workbook: every KPI table plus the filtered source rows. */
  function exportWorkbook() {
    var ctx = compute();
    var sheets = [];

    sheets.push(['Summary', [
      { Metric: 'Total Sellout Target', Value: Math.round(ctx.totals.target) },
      { Metric: 'Total Sellout Actual', Value: Math.round(ctx.totals.actual) },
      { Metric: 'Balance (Target - Actual)', Value: Math.round(ctx.totals.balance) },
      { Metric: 'Overall Achievement %', Value: Number(ctx.totals.ach.toFixed(2)) },
      { Metric: 'Unique Buying Accounts', Value: ctx.uba },
      { Metric: 'MCL Compliance %', Value: ctx.mclOverall ? Number(ctx.mclOverall.pct.toFixed(2)) : '' },
      { Metric: 'MCL accounts evaluated', Value: ctx.mclOverall ? ctx.mclOverall.evaluated : '' },
      { Metric: 'MCL accounts excluded (no required list)', Value: ctx.mclOverall ? ctx.mclOverall.noTarget : '' },
      { Metric: 'Promo Distribution %', Value: ctx.promoOverall ? Number(ctx.promoOverall.pct.toFixed(2)) : '' },
      { Metric: 'Rows in scope', Value: ctx.rows.length },
      { Metric: 'Exported', Value: new Date().toLocaleString() }
    ]]);

    ['salesman', 'channel', 'category'].forEach(function (role) {
      var dim = dimByRole(role);
      if (!dim) return;
      sheets.push(['Sellout by ' + dim.label, K.sellout(ctx.rows, dim.key).map(function (s) {
        return { [dim.label]: s.label, Target: Math.round(s.target), Actual: Math.round(s.actual),
                 Balance: Math.round(s.balance), 'Achievement %': Number(s.ach.toFixed(2)) };
      })]);
    });

    var custKey = M.roles.customercode || M.roles.customer;
    var smDim = dimByRole('salesman'), chDim = dimByRole('channel');
    if (custKey && smDim && chDim) {
      var mx = K.ubaMatrix(ctx.rows, custKey, smDim.key, chDim.key);
      var ubaRows = [];
      mx.rowLabels.forEach(function (rl, i) {
        var o = { [smDim.label]: rl };
        mx.colLabels.forEach(function (cl, j) { o[cl] = mx.matrix[i][j]; });
        o['TOTAL'] = mx.rowTotals[i];
        ubaRows.push(o);
      });
      sheets.push(['UBA by Salesman x Channel', ubaRows]);
    }

    [['MCL', ctx.mclUnits], ['Promo', ctx.promoUnits]].forEach(function (p) {
      if (!p[1]) return;
      sheets.push([p[0] + ' Account Detail', p[1].map(function (u) {
        return { Account: u.customerName, 'Customer Code': u.customer, 'Product Class': u.productClass,
                 Channel: u.channel, Salesman: u.salesman, Required: u.required, Purchased: u.purchased,
                 'Compliance %': u.evaluated ? Number(u.pct.toFixed(2)) : '',
                 Status: !u.evaluated ? 'No required list (excluded)' : (u.compliant ? 'Compliant' : 'Not compliant') };
      })]);
    });

    if (!global.XLSX) {
      downloadCSV(sheets[0][1], 'CDO_KPI_Summary.csv');
      toast('Excel library unavailable — exported summary CSV');
      return;
    }
    var wb = XLSX.utils.book_new();
    sheets.forEach(function (s) {
      if (s[1] && s[1].length) XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(s[1]), sheetName(s[0]));
    });
    XLSX.writeFile(wb, 'CDO_Foodsphere_KPI_' + new Date().toISOString().slice(0, 10) + '.xlsx');
    toast('Workbook exported (' + wb.SheetNames.length + ' sheets)');
  }

  /* ---------------------------------------------------------- */
  /* Compute + render                                           */
  /* ---------------------------------------------------------- */
  function dimByRole(role) {
    for (var i = 0; i < M.dims.length; i++) if (M.dims[i].role === role) return M.dims[i];
    return null;
  }

  function compute() {
    var rows = D.applyFilters(state.selections);
    var custKey = M.roles.customercode || M.roles.customer;
    var mclUnits = K.complianceUnits(rows, M.roles, M.requirements.mcl);
    var promoUnits = M.requirements.promo === M.requirements.mcl
      ? mclUnits
      : K.complianceUnits(rows, M.roles, M.requirements.promo);

    var denom = 0;
    if (custKey) {
      var seen = Object.create(null);
      for (var i = 0; i < rows.length; i++) { var c = rows[i][custKey]; if (!D.isBlank(c)) seen[c] = 1; }
      denom = Object.keys(seen).length;
    }

    return {
      rows: rows,
      totals: K.selloutTotals(rows),
      uba: custKey ? K.ubaTotal(rows, custKey) : 0,
      ubaDenom: denom,
      mclUnits: mclUnits,
      promoUnits: promoUnits,
      mclOverall: mclUnits ? K.complianceOverall(mclUnits) : null,
      promoOverall: promoUnits ? K.complianceOverall(promoUnits) : null
    };
  }

  function renderAll() {
    if (state.building) return;
    state.building = true;
    try {
      var ctx = compute();
      state.filtered = ctx.rows;

      $('#rowCount').textContent = K.nf(ctx.rows.length) + ' of ' + K.nf(M.rows.length) + ' rows in scope';
      renderCards(ctx);

      // KPI 1 — three sellout views
      var h1 = $('#kpi1Host'); h1.innerHTML = '';
      [['salesman', 'Sellout Performance per Salesman'],
       ['channel', 'Sellout Performance per Channel'],
       ['category', 'Sellout Performance per Category']].forEach(function (v) {
        var dim = dimByRole(v[0]);
        if (!dim) return;
        buildSelloutBlock(h1, 'so-' + v[0], v[1], dim, ctx.rows);
      });
      if (!h1.children.length) h1.appendChild(block({ id: 'so-na', title: 'Sellout Performance', empty: 'No salesperson, channel or category column detected.' }));

      // KPI 2 — UBA
      var h2 = $('#kpi2Host'); h2.innerHTML = '';
      buildUBABlock(h2, ctx.rows, ctx);

      // KPI 3 — MCL
      var h3 = $('#kpi3Host'); h3.innerHTML = '';
      buildComplianceBlocks(h3, ctx.mclUnits, ctx.mclOverall, 'MCL', 'mcl-');

      // KPI 4 — Promo
      var h4 = $('#kpi4Host'); h4.innerHTML = '';
      buildComplianceBlocks(h4, ctx.promoUnits, ctx.promoOverall, 'Promo', 'promo-');
    } finally {
      state.building = false;
    }
  }

  function stampRefresh(note) {
    var d = M.lastRefresh || new Date();
    $('#lastRefresh').textContent = d.toLocaleString('en-PH', {
      year: 'numeric', month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: true
    });
    $('#refreshMeta').textContent = note || (K.nf(M.rows.length) + ' sellout rows · ' + M.tabs.length + ' tabs detected');
    $('#refreshCard').classList.remove('is-stale');
    var names = M.tabs.map(function (t) { return t.name; }).join(', ');
    $('#footerMeta').textContent = 'Data source: CDO KPI Monitoring (published Google Sheet) · tabs: ' + names;
  }

  /* ---------------------------------------------------------- */
  /* Load / refresh                                             */
  /* ---------------------------------------------------------- */
  function doLoad(isRefresh) {
    var btn = $('#btnRefresh');
    btn.classList.add('is-loading');
    return D.load().then(function () {
      renderNotices();
      renderFilters();
      onFilterChangeSilent();
      stampRefresh();
      if (isRefresh) toast('Data refreshed');
    }).catch(function (err) {
      M.notices = [{ level: 'err', text: '<strong>Could not load the data source.</strong> ' + K.esc(err.message) +
        ' — check that the Google Sheet is still published to the web (File → Share → Publish to web).' }];
      renderNotices();
      $('#lastRefresh').textContent = 'Unavailable';
      $('#refreshMeta').textContent = 'Load failed';
      $('#refreshCard').classList.add('is-stale');
    }).then(function () {
      btn.classList.remove('is-loading');
    });
  }

  function onFilterChangeSilent() {
    // keep selections that still exist after a reload
    Object.keys(state.selections).forEach(function (k) {
      var dim = null;
      for (var i = 0; i < M.dims.length; i++) if (M.dims[i].key === k) dim = M.dims[i];
      if (!dim) { delete state.selections[k]; return; }
      state.selections[k] = state.selections[k].filter(function (v) { return dim.values.indexOf(v) >= 0; });
    });
    syncFilterButtons();
    renderAll();
  }

  function startAutoRefresh() {
    if (state.refreshTimer) clearInterval(state.refreshTimer);
    state.refreshTimer = setInterval(function () {
      if (document.hidden) return;
      D.checkForChanges().then(function (changed) {
        if (changed) {
          $('#refreshCard').classList.add('is-stale');
          $('#refreshMeta').textContent = 'Source sheet changed — reloading…';
          doLoad(true);
        }
      }).catch(function () { /* transient network issue — try again next tick */ });
    }, D.CONFIG.refreshMs);
  }

  /* ---------------------------------------------------------- */
  /* Init                                                       */
  /* ---------------------------------------------------------- */
  function init() {
    initTheme();
    $('#btnRefresh').addEventListener('click', function () { doLoad(true); });
    $('#btnPrint').addEventListener('click', function () { global.print(); });
    $('#btnResetAll').addEventListener('click', function () {
      state.selections = {}; state.drill = {};
      syncFilterButtons(); renderAll(); toast('All filters cleared');
    });
    document.addEventListener('click', closePop);
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape') closePop(); });
    global.addEventListener('resize', function () {
      clearTimeout(init._r);
      init._r = setTimeout(function () {
        Object.keys(state.charts).forEach(function (k) { if (state.charts[k]) state.charts[k].resize(); });
      }, 160);
    });

    doLoad(false).then(startAutoRefresh);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();

  global.CDOUi = { state: state, renderAll: renderAll, compute: compute };
})(window);
