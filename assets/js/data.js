/* ============================================================
   data.js — data source, schema auto-detection, filter engine
   ------------------------------------------------------------
   Design goals (from the requirements):
     • Read the published Google Sheet live, no build step.
     • Auto-discover every tab in the workbook (so new tabs added
       later are picked up with no code change).
     • Auto-detect column headers and assign semantic roles.
     • Treat any non-fact, non-requirement tab as a lookup table
       and left-join it onto the fact table — that is how a
       "salesman code -> salesman position" tab becomes a filter
       dimension automatically.
     • Build cascading relationships between dimensions from the
       data itself (co-occurrence), not from a hard-coded tree.
   ============================================================ */
(function (global) {
  'use strict';

  /* ---------------------------------------------------------- */
  /* Configuration                                              */
  /* ---------------------------------------------------------- */
  var CONFIG = {
    // Published-to-web key of the "CDO KPI Monitoring" workbook.
    pubKey: '2PACX-1vQZ4ahKecCkUksXJ6TC8ZBbhvPK0OEMApzqvl2MlYlU7_2Abnbvht75ydCBKd6-w5w7bDrsjT6NotYo',
    // Fallback gids, used only if tab auto-discovery fails.
    fallbackGids: ['0', '1698044101', '467994906'],
    refreshMs: 5 * 60 * 1000,      // poll the sheet every 5 minutes
    complianceThreshold: 85,       // % of required products for an account to be compliant
    // Accounts whose Channel + Product Class has no required product list are
    // excluded from compliance denominators and reported separately.
    noRequirementMode: 'exclude'   // 'exclude' | 'zero' | 'full'
  };
  CONFIG.base = 'https://docs.google.com/spreadsheets/d/e/' + CONFIG.pubKey;

  /* ---------------------------------------------------------- */
  /* Small utilities                                            */
  /* ---------------------------------------------------------- */
  function norm(h) { return String(h == null ? '' : h).toLowerCase().replace(/[^a-z0-9]/g, ''); }

  function toNumber(v) {
    if (v == null) return 0;
    var s = String(v).trim();
    if (s === '' || s === '-' || s === '—' || s === 'n/a' || s === 'NA') return 0;
    var neg = /^\(.*\)$/.test(s);                  // (1,234) accounting negatives
    s = s.replace(/[()]/g, '').replace(/[₱$,\s]/g, '');
    var n = parseFloat(s);
    if (isNaN(n)) return 0;
    return neg ? -n : n;
  }

  function isBlank(v) { var s = String(v == null ? '' : v).trim(); return s === '' || s === '-' || s === '—'; }

  function hash(str) {                              // cheap change-detection digest
    var h = 5381, i = str.length;
    while (i) { h = (h * 33) ^ str.charCodeAt(--i); }
    return (h >>> 0).toString(36) + ':' + str.length;
  }

  /* ---------------------------------------------------------- */
  /* RFC-4180 CSV parser (quoted fields, embedded commas/CRLF)  */
  /* ---------------------------------------------------------- */
  function parseCSV(text) {
    var rows = [], field = '', row = [], inQ = false, i, c;
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);   // strip BOM
    for (i = 0; i < text.length; i++) {
      c = text[i];
      if (inQ) {
        if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else inQ = false; }
        else field += c;
      } else {
        if (c === '"') inQ = true;
        else if (c === ',') { row.push(field); field = ''; }
        else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
        else if (c !== '\r') field += c;
      }
    }
    if (field !== '' || row.length) { row.push(field); rows.push(row); }
    // drop fully-empty rows
    return rows.filter(function (r) { return r.some(function (v) { return String(v).trim() !== ''; }); });
  }

  /** Turn a CSV string into {headers, normHeaders, rows:[{normKey:value}]} */
  function tableFromCSV(text) {
    var m = parseCSV(text);
    if (!m.length) return { headers: [], normHeaders: [], rows: [] };
    var headers = m[0].map(function (h) { return String(h).trim(); });
    var seen = {}, normHeaders = headers.map(function (h) {
      var k = norm(h) || 'col';
      if (seen[k] != null) { seen[k]++; k = k + seen[k]; } else seen[k] = 0;
      return k;
    });
    var rows = [], r, o, j;
    for (var i = 1; i < m.length; i++) {
      r = m[i]; o = {};
      for (j = 0; j < normHeaders.length; j++) o[normHeaders[j]] = (r[j] == null ? '' : String(r[j]).trim());
      rows.push(o);
    }
    return { headers: headers, normHeaders: normHeaders, rows: rows };
  }

  /* ---------------------------------------------------------- */
  /* Network                                                    */
  /* ---------------------------------------------------------- */
  function bust(url) { return url + (url.indexOf('?') < 0 ? '?' : '&') + '_=' + Date.now(); }

  function fetchText(url) {
    return fetch(bust(url), { cache: 'no-store', credentials: 'omit' }).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status + ' for ' + url);
      return r.text();
    });
  }

  function csvUrl(gid) { return CONFIG.base + '/pub?gid=' + gid + '&single=true&output=csv'; }

  /**
   * Discover every published tab (name + gid) by reading the pubhtml
   * page switcher. New tabs appear here automatically.
   */
  function discoverTabs() {
    return fetchText(CONFIG.base + '/pubhtml').then(function (html) {
      var tabs = [], re = /name:\s*"((?:[^"\\]|\\.)*)"\s*,\s*pageUrl:\s*"[^"]*"\s*,\s*gid:\s*"(-?\d+)"/g, m;
      while ((m = re.exec(html)) !== null) {
        tabs.push({ name: m[1].replace(/\\(.)/g, '$1'), gid: m[2] });
      }
      if (!tabs.length) throw new Error('no tabs found in pubhtml');
      return tabs;
    }).catch(function () {
      return CONFIG.fallbackGids.map(function (g, i) { return { name: 'Sheet ' + (i + 1), gid: g }; });
    });
  }

  /* ---------------------------------------------------------- */
  /* Role detection                                             */
  /* ---------------------------------------------------------- */
  // Ordered: first matching pattern wins for a given role.
  var ROLE_PATTERNS = [
    ['target',      /^(sellout)?target(amount|value|sales|qty)?$/],
    ['actual',      /^(sellout)?actual(amount|value|sales|qty)?$/],
    ['productclass',/productclass|prodclass|^class$/],
    ['position',    /salesmanposition|salespersonposition|^position$|^designation$|^role$|salesmantype|^saleschannelrole$/],
    ['salesman',    /salesmanname|salespersonname|^salesman$|^salesperson$|^salesmandescription$/],
    ['salesmancode',/salesmancode|salespersoncode|^slmcode$|^salesmanid$/],
    ['customer',    /customername|accountname|^customer$|^account$|outletname|storename/],
    ['customercode',/customercode|accountcode|^customerid$|^accountid$|outletcode/],
    ['channel',     /tradechannel|^channel$|storeformat|^format$|customerchannel/],
    ['category',    /^category$|^productcategory$|^subcategory$/],
    ['brand',       /^brand$|^brandname$/],
    ['variant',     /^variant$|^variantname$|^segment$/],
    ['product',     /productdescription|productdesc|itemdescription|^product$|^itemname$/],
    ['productcode', /productcode|^itemcode$|^sku$|^materialcode$/],
    ['date',        /^date$|^period$|^transactiondate$|^invoicedate$|^salesdate$|^postingdate$/],
    ['year',        /^year$|^yr$|^fiscalyear$/],
    ['month',       /^month$|^mo$|^monthname$|^period(month)?name$/],
    ['reqtarget',   /^(mcl|promo|required)?target(products?|qty|count)?$|^mcltarget$|^promotarget$|^required$/]
  ];

  function detectRoles(normHeaders) {
    var roles = {}, used = {};
    ROLE_PATTERNS.forEach(function (p) {
      var role = p[0], re = p[1];
      if (roles[role]) return;
      for (var i = 0; i < normHeaders.length; i++) {
        var h = normHeaders[i];
        if (used[h]) continue;
        if (re.test(h)) { roles[role] = h; used[h] = 1; return; }
      }
    });
    return roles;
  }

  /* ---------------------------------------------------------- */
  /* Tab classification                                         */
  /* ---------------------------------------------------------- */
  function classify(tab, table) {
    var r = detectRoles(table.normHeaders), n = table.normHeaders;
    var has = function (k) { return !!r[k]; };
    var hasCustomer = has('customer') || has('customercode');

    // Fact table: target + actual at transaction/account grain.
    if (has('target') && has('actual') && hasCustomer) return { kind: 'fact', roles: r };

    // Requirement list: product list keyed by channel + product class.
    if ((has('productcode') || has('product')) && has('channel') && has('productclass') && !hasCustomer && !has('actual')) {
      var which = /mcl|mustcarry|must.carry/i.test(tab.name) ? 'mcl'
                : /promo/i.test(tab.name) ? 'promo'
                : (n.indexOf('mcltarget') >= 0 ? 'mcl' : (n.indexOf('promotarget') >= 0 ? 'promo' : 'unknown'));
      return { kind: 'requirement', which: which, roles: r };
    }

    // Anything else is a candidate lookup / dimension table.
    return { kind: 'lookup', roles: r };
  }

  /* ---------------------------------------------------------- */
  /* Dimension labelling                                        */
  /* ---------------------------------------------------------- */
  var LABELS = {
    position: 'Salesman Position', salesman: 'Salesperson', salesmancode: 'Salesman Code',
    productclass: 'Product Class', channel: 'Channel', category: 'Category',
    brand: 'Brand', variant: 'Variant', product: 'Product', productcode: 'Product Code',
    customer: 'Customer', customercode: 'Customer Code', year: 'Year', month: 'Month'
  };
  // Preferred filter order (spec order first, then extras).
  var DIM_ORDER = ['position', 'salesman', 'productclass', 'channel', 'category', 'year', 'month', 'brand', 'variant', 'product'];

  function titleize(normKey, originalHeader) {
    if (originalHeader) {
      return String(originalHeader).replace(/[_\-]+/g, ' ').replace(/\s+/g, ' ').trim()
        .replace(/\b\w/g, function (c) { return c.toUpperCase(); });
    }
    return normKey.replace(/\b\w/g, function (c) { return c.toUpperCase(); });
  }

  var MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
  function monthRank(v) {
    var s = String(v).toLowerCase().trim();
    var n = parseInt(s, 10);
    if (!isNaN(n) && n >= 1 && n <= 12 && /^\d+$/.test(s)) return n;
    for (var i = 0; i < 12; i++) if (MONTHS[i].indexOf(s.slice(0, 3)) === 0) return i + 1;
    return 99;
  }

  function sortValues(key, vals) {
    if (key === 'month') return vals.slice().sort(function (a, b) { return monthRank(a) - monthRank(b) || String(a).localeCompare(String(b)); });
    var allNum = vals.every(function (v) { return v !== '' && !isNaN(Number(String(v).replace(/,/g, ''))); });
    if (allNum) return vals.slice().sort(function (a, b) { return Number(String(a).replace(/,/g, '')) - Number(String(b).replace(/,/g, '')); });
    return vals.slice().sort(function (a, b) { return String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: 'base' }); });
  }

  /* ---------------------------------------------------------- */
  /* Model construction                                         */
  /* ---------------------------------------------------------- */
  var model = {
    loaded: false, rows: [], roles: {}, dims: [], headerLabels: {},
    requirements: { mcl: null, promo: null },
    tabs: [], notices: [], lastRefresh: null, digest: ''
  };

  function load() {
    model.notices = [];
    return discoverTabs().then(function (tabs) {
      return Promise.all(tabs.map(function (t) {
        return fetchText(csvUrl(t.gid))
          .then(function (txt) { return { tab: t, text: txt, table: tableFromCSV(txt) }; })
          .catch(function (e) { return { tab: t, error: e.message, table: { headers: [], normHeaders: [], rows: [] } }; });
      }));
    }).then(function (loaded) {
      return build(loaded);
    });
  }

  function build(loaded) {
    var facts = [], reqs = [], lookups = [], digestParts = [];

    loaded.forEach(function (L) {
      if (L.error) { model.notices.push({ level: 'warn', text: 'Could not read tab “' + L.tab.name + '”: ' + L.error }); return; }
      if (!L.table.rows.length) return;
      digestParts.push(L.tab.gid + '#' + hash(L.text || ''));
      var c = classify(L.tab, L.table);
      L.cls = c;
      if (c.kind === 'fact') facts.push(L);
      else if (c.kind === 'requirement') reqs.push(L);
      else lookups.push(L);
    });

    if (!facts.length) throw new Error('No sellout fact table found. A tab needs Target, Actual and a customer column.');

    // ---- Fact table: largest fact tab wins; others appended if schema matches
    facts.sort(function (a, b) { return b.table.rows.length - a.table.rows.length; });
    var factTab = facts[0];
    var roles = factTab.cls.roles;
    var rows = factTab.table.rows.slice();
    var labels = {};
    factTab.table.normHeaders.forEach(function (k, i) { labels[k] = factTab.table.headers[i]; });

    facts.slice(1).forEach(function (f) {
      var fr = f.cls.roles;
      if (fr.target && fr.actual) {
        f.table.rows.forEach(function (r) { rows.push(r); });
        f.table.normHeaders.forEach(function (k, i) { if (!labels[k]) labels[k] = f.table.headers[i]; });
      }
    });

    // ---- Join lookup tabs onto the fact table (auto dimension enrichment)
    var factKeys = Object.keys(rows[0] || {});
    lookups.forEach(function (L) {
      var lkHeaders = L.table.normHeaders;
      // Choose a join key: a column present in both, with good coverage.
      var key = null, bestCov = 0;
      lkHeaders.forEach(function (h) {
        if (factKeys.indexOf(h) < 0) return;
        var vals = {}, i;
        for (i = 0; i < L.table.rows.length; i++) vals[L.table.rows[i][h]] = 1;
        var matched = 0, sample = Math.min(rows.length, 1500);
        for (i = 0; i < sample; i++) if (vals[rows[i][h]]) matched++;
        var cov = matched / sample;
        if (cov > bestCov) { bestCov = cov; key = h; }
      });

      if (!key || bestCov < 0.1) {
        model.notices.push({
          level: 'info',
          text: 'Tab “' + L.tab.name + '” was read but not linked — no column in it matches a Sellout column. ' +
                'Give it a column named exactly like one in Sellout (for example salesman_code) and it will join automatically.'
        });
        return;
      }

      var newCols = lkHeaders.filter(function (h) { return h !== key && factKeys.indexOf(h) < 0; });
      if (!newCols.length) return;

      var map = Object.create(null);
      L.table.rows.forEach(function (r) { if (!isBlank(r[key])) map[r[key]] = r; });
      rows.forEach(function (r) {
        var src = map[r[key]];
        newCols.forEach(function (c) { r[c] = src ? src[c] : ''; });
      });
      L.table.normHeaders.forEach(function (k, i) { if (!labels[k]) labels[k] = L.table.headers[i]; });
      factKeys = factKeys.concat(newCols);

      // Re-detect roles so a joined column (e.g. Salesman Position) gets its role.
      var merged = detectRoles(factKeys);
      Object.keys(merged).forEach(function (rk) { if (!roles[rk]) roles[rk] = merged[rk]; });

      model.notices.push({
        level: 'info',
        text: 'Linked tab “' + L.tab.name + '” on <strong>' + (labels[key] || key) + '</strong>, adding ' +
              newCols.map(function (c) { return '<strong>' + (labels[c] || c) + '</strong>'; }).join(', ') +
              ' as new dashboard dimension' + (newCols.length > 1 ? 's' : '') + '.'
      });
    });

    // ---- Requirement lists
    model.requirements = { mcl: null, promo: null };
    reqs.forEach(function (L) {
      var w = L.cls.which;
      if (w === 'unknown') w = model.requirements.mcl ? 'promo' : 'mcl';
      model.requirements[w] = buildRequirementIndex(L);
    });
    if (!model.requirements.mcl && model.requirements.promo) model.requirements.mcl = model.requirements.promo;
    if (!model.requirements.promo && model.requirements.mcl) model.requirements.promo = model.requirements.mcl;

    // Flag the MCL / Promo duplication explicitly — it is a data condition
    // the business needs to know about, not something to paper over.
    if (model.requirements.mcl && model.requirements.promo) {
      if (model.requirements.mcl.signature === model.requirements.promo.signature) {
        model.notices.push({
          level: 'warn',
          text: '<strong>MCL and Promo product lists are identical</strong> (' + model.requirements.mcl.total +
                ' products each), so KPI 3 and KPI 4 will report the same figures. ' +
                'Populate the “MCL Target” tab with the real must-carry list to separate them.'
        });
      }
    }

    // ---- Numeric pre-parse + derived period fields
    var tK = roles.target, aK = roles.actual;
    rows.forEach(function (r) {
      r.__t = toNumber(r[tK]);
      r.__a = toNumber(r[aK]);
    });

    // Derive Year / Month from a date column if one exists and they are absent.
    if (roles.date && (!roles.year || !roles.month)) {
      var derivedY = 0;
      rows.forEach(function (r) {
        var d = new Date(r[roles.date]);
        if (!isNaN(d.getTime())) {
          if (!roles.year) r.__year = String(d.getFullYear());
          if (!roles.month) r.__month = MONTHS[d.getMonth()].replace(/\b\w/, function (c) { return c.toUpperCase(); });
          derivedY++;
        } else { r.__year = r.__year || ''; r.__month = r.__month || ''; }
      });
      if (derivedY > 0) {
        if (!roles.year) { roles.year = '__year'; labels.__year = 'Year'; }
        if (!roles.month) { roles.month = '__month'; labels.__month = 'Month'; }
      }
    }

    // ---- Dimension registry (everything filterable)
    var EXCLUDE_ROLES = ['target', 'actual', 'reqtarget'];
    var excludeKeys = {};
    EXCLUDE_ROLES.forEach(function (r) { if (roles[r]) excludeKeys[roles[r]] = 1; });
    // Hide an identifier column when a friendlier twin exists.
    [['salesmancode', 'salesman'], ['customercode', 'customer'], ['productcode', 'product']].forEach(function (p) {
      if (roles[p[0]] && roles[p[1]]) excludeKeys[roles[p[0]]] = 1;
    });

    var roleOf = {};
    Object.keys(roles).forEach(function (rk) { roleOf[roles[rk]] = rk; });

    var dims = [];
    Object.keys(rows[0] || {}).forEach(function (k) {
      if (k.slice(0, 2) === '__' && k !== '__year' && k !== '__month') return;
      if (excludeKeys[k]) return;
      var set = Object.create(null), nDistinct = 0, nonBlank = 0, i;
      for (i = 0; i < rows.length; i++) {
        var v = rows[i][k];
        if (isBlank(v)) continue;
        nonBlank++;
        if (set[v] === undefined) { set[v] = 1; nDistinct++; }
      }
      if (nDistinct < 2 || nonBlank === 0) return;             // nothing to filter on
      if (nDistinct > 300) return;                             // too granular for a checklist
      var role = roleOf[k] || null;
      dims.push({
        key: k, role: role,
        label: LABELS[role] || titleize(k, labels[k]),
        values: sortValues(role === 'month' ? 'month' : k, Object.keys(set)),
        distinct: nDistinct
      });
    });

    dims.sort(function (a, b) {
      var ai = a.role ? DIM_ORDER.indexOf(a.role) : -1, bi = b.role ? DIM_ORDER.indexOf(b.role) : -1;
      if (ai < 0) ai = 99; if (bi < 0) bi = 99;
      if (ai !== bi) return ai - bi;
      return a.label.localeCompare(b.label);
    });

    if (!roles.year && !roles.month) {
      model.notices.push({
        level: 'info',
        text: 'No date, Year or Month column found in the Sellout tab, so the period filters are hidden. ' +
              'Add a <strong>Date</strong> column (or <strong>Year</strong> and <strong>Month</strong>) and they will appear automatically.'
      });
    }

    model.rows = rows;
    model.roles = roles;
    model.dims = dims;
    model.headerLabels = labels;
    model.tabs = loaded.map(function (L) { return { name: L.tab.name, gid: L.tab.gid, kind: L.cls ? L.cls.kind : 'error', rows: L.table.rows.length }; });
    model.digest = digestParts.sort().join('|');
    model.lastRefresh = new Date();
    model.loaded = true;
    return model;
  }

  /**
   * Index a requirement list (MCL / Promo) by Channel + Product Class.
   * Returns { byKey: {"channel||class": Set(productCode)}, total, signature }
   */
  function buildRequirementIndex(L) {
    var r = L.cls.roles, t = L.table;
    var chK = r.channel, pcK = r.productclass, codeK = r.productcode || r.product;
    var byKey = Object.create(null), codes = Object.create(null), rowsUsed = 0, sigParts = [];

    t.rows.forEach(function (row) {
      var ch = String(row[chK] || '').trim(), pc = String(row[pcK] || '').trim(), code = String(row[codeK] || '').trim();
      if (!ch || !pc || !code) return;
      // A requirement-count column (Promo Target / MCL Target) of 0 means "not required".
      if (r.reqtarget && row[r.reqtarget] !== undefined && !isBlank(row[r.reqtarget]) && toNumber(row[r.reqtarget]) <= 0) return;
      var key = ch.toUpperCase() + '||' + pc.toUpperCase();
      if (!byKey[key]) byKey[key] = Object.create(null);
      if (!byKey[key][code]) { byKey[key][code] = 1; rowsUsed++; sigParts.push(key + '>' + code); }
      codes[code] = 1;
    });

    return {
      name: L.tab.name,
      byKey: byKey,
      total: rowsUsed,
      distinctCodes: Object.keys(codes).length,
      keys: Object.keys(byKey),
      signature: hash(sigParts.sort().join(';')),
      requiredFor: function (channel, productClass) {
        return byKey[String(channel || '').trim().toUpperCase() + '||' + String(productClass || '').trim().toUpperCase()] || null;
      }
    };
  }

  /* ---------------------------------------------------------- */
  /* Filtering + cascade                                        */
  /* ---------------------------------------------------------- */
  /** selections: { dimKey: [values...] }  (empty / missing = All) */
  function matches(row, selections, skipKey) {
    for (var k in selections) {
      if (k === skipKey) continue;
      var sel = selections[k];
      if (!sel || !sel.length) continue;
      if (sel.indexOf(row[k]) < 0) return false;
    }
    return true;
  }

  function applyFilters(selections) {
    var out = [], rows = model.rows, i;
    for (i = 0; i < rows.length; i++) if (matches(rows[i], selections, null)) out.push(rows[i]);
    return out;
  }

  /**
   * Cascade: the options a dimension should offer are the values still
   * reachable given every OTHER dimension's selection. Counts come from the
   * fully-filtered set so the numbers next to each option are meaningful.
   */
  function optionsFor(dim, selections) {
    var reach = Object.create(null), counts = Object.create(null), rows = model.rows, i, v;
    for (i = 0; i < rows.length; i++) {
      if (!matches(rows[i], selections, dim.key)) continue;
      v = rows[i][dim.key];
      if (isBlank(v)) continue;
      if (reach[v] === undefined) reach[v] = 0;
      reach[v]++;
    }
    var vals = sortValues(dim.role === 'month' ? 'month' : dim.key, Object.keys(reach));
    return vals.map(function (x) { return { value: x, count: reach[x] }; });
  }

  /* ---------------------------------------------------------- */
  /* Auto-refresh                                               */
  /* ---------------------------------------------------------- */
  function checkForChanges() {
    return discoverTabs().then(function (tabs) {
      return Promise.all(tabs.map(function (t) {
        return fetchText(csvUrl(t.gid)).then(function (txt) { return t.gid + '#' + hash(txt); }).catch(function () { return t.gid + '#err'; });
      }));
    }).then(function (parts) { return parts.sort().join('|') !== model.digest; });
  }

  global.CDOData = {
    CONFIG: CONFIG,
    model: model,
    load: load,
    applyFilters: applyFilters,
    optionsFor: optionsFor,
    checkForChanges: checkForChanges,
    toNumber: toNumber,
    isBlank: isBlank,
    parseCSV: parseCSV,
    norm: norm,
    monthRank: monthRank
  };
})(window);
