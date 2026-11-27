// Token Radar page. Reads window.RADAR (data.js, written by main.ts from the same rows as board.json)
// and renders three views: the pre-token board, the trading comparables the model is calibrated on,
// and the model itself. State lives in the URL hash, so every view is linkable and reloadable.
(function () {
  'use strict';
  var D = window.RADAR;
  if (!D) return;
  var $ = function (id) { return document.getElementById(id); };
  var DFLT = { tab: 'board', q: '', cat: '', chain: '', set: 'all', min: 0, sort: 'rank', dir: 1, p: '', v: '' };
  var S = Object.assign({}, DFLT);

  // ------------------------------------------------------------ formatting
  function money(n) {
    if (n === null || n === undefined) return 'n/a';
    var a = Math.abs(n);
    if (a >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B';
    if (a >= 1e6) return '$' + (n / 1e6).toFixed(1) + 'M';
    if (a >= 1e3) return '$' + Math.round(n / 1e3) + 'K';
    return '$' + Math.round(n);
  }
  function whole(n) { return '$' + Math.round(n).toLocaleString('en-US'); }
  function pct(n) { return n === null || n === undefined ? 'n/a' : (n > 0 ? '+' : '') + n.toFixed(2) + '%'; }
  function cls(n) { return n === null || n === undefined || n === 0 ? 'dim' : n > 0 ? 'up' : 'down'; }
  function age(d) { return d === null || d === undefined ? 'unlisted' : d >= 365 ? (d / 365).toFixed(1) + 'y' : d + 'd'; }
  function x(n) { return n.toFixed(3) + '×'; }
  function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  function chains(list, hi) {
    // The farm chain leads, so the column always names where the plan is run.
    var order = hi ? [hi].concat(list.filter(function (c) { return c !== hi; })) : list;
    var head = order.slice(0, 2).map(function (c) { return c === hi ? '<i>' + esc(c) + '</i>' : esc(c); }).join(', ');
    return head + (list.length > 2 ? ' <span class="dim">+' + (list.length - 2) + '</span>' : '');
  }

  // ------------------------------------------------------------ hash state
  function readHash() {
    var h = location.hash.replace(/^#/, '');
    h.split('&').forEach(function (kv) {
      var i = kv.indexOf('=');
      if (i < 1) return;
      var k = kv.slice(0, i), v = decodeURIComponent(kv.slice(i + 1));
      if (k in S) S[k] = k === 'min' || k === 'dir' ? Number(v) || 0 : v;
    });
    if (S.dir !== 1 && S.dir !== -1) S.dir = 1;
  }
  function writeHash() {
    var parts = [];
    Object.keys(S).forEach(function (k) {
      if (S[k] !== DFLT[k]) parts.push(k + '=' + encodeURIComponent(S[k]));
    });
    history.replaceState(null, '', parts.length ? '#' + parts.join('&') : location.pathname);
  }

  // ------------------------------------------------------------ filtering and sorting
  var rows = D.rows;
  // The meter is log-scaled between the board's smallest and largest value, so both ends stay readable.
  var lo = Math.log(rows[rows.length - 1].implied_value_usd), span = Math.log(rows[0].implied_value_usd) - lo || 1;
  function matches(r) {
    if (S.cat && (r.category || 'Uncategorised') !== S.cat) return false;
    if (S.chain && r.chains.indexOf(S.chain) < 0) return false;
    if (S.min && r.tvl_usd < S.min) return false;
    if (S.set === 'watch' && !r.on_watchlist) return false;
    if (S.set === 'early' && r.on_watchlist) return false;
    if (S.q) {
      var hay = (r.name + ' ' + r.slug + ' ' + (r.category || '') + ' ' + r.chains.join(' ')).toLowerCase();
      if (hay.indexOf(S.q.toLowerCase()) < 0) return false;
    }
    return true;
  }
  var KEYS = {
    rank: function (r) { return r.rank; },
    name: function (r) { return r.name.toLowerCase(); },
    category: function (r) { return (r.category || '').toLowerCase(); },
    tvl: function (r) { return r.tvl_usd; },
    chg: function (r) { return r.change_7d === null ? -1e9 : r.change_7d; },
    age: function (r) { return r.age_days === null ? -1 : r.age_days; },
    mult: function (r) { return r.model ? r.model.peer_multiple : r.mcap_usd / r.tvl_usd; },
    iv: function (r) { return r.implied_value_usd; },
    mcap: function (r) { return r.mcap_usd; },
    model: function (r) { return r.model_value_usd; },
    ratio: function (r) { return r.model_value_usd / r.mcap_usd; },
  };
  function sorted(list) {
    var key = KEYS[S.sort] || KEYS.rank;
    return list.slice().sort(function (a, b) {
      var ka = key(a), kb = key(b);
      return (ka < kb ? -1 : ka > kb ? 1 : 0) * S.dir || a.slug.localeCompare(b.slug);
    });
  }

  // ------------------------------------------------------------ table
  function th(label, key, right, firstDir) {
    var sort = S.sort === key ? (S.dir === 1 ? 'ascending' : 'descending') : null;
    return '<th' + (right ? ' class="r"' : '') + (sort ? ' aria-sort="' + sort + '"' : '') + '><button type="button" data-sort="' + key + '" data-first="' + (firstDir || -1) + '">' + label + '</button></th>';
  }
  function boardTable(list) {
    var head = '<tr>' + th('#', 'rank', false, 1) + th('Protocol', 'name', false, 1) + th('Category', 'category', false, 1) + '<th>Chains</th>' +
      th('TVL', 'tvl', true) + th('7d', 'chg', true) + th('Age', 'age', true) + th('Peer ×', 'mult', true) + th('Implied value', 'iv', true) + '<th class="r">Stake · hold</th></tr>';
    var body = list.map(function (r) {
      var w = 6 + 94 * (Math.log(r.implied_value_usd) - lo) / span;
      return '<tr data-slug="' + esc(r.slug) + '" aria-selected="' + (r.slug === S.p) + '">' +
        '<td class="rk num">' + r.rank + '</td>' +
        '<td class="nm" title="' + esc(r.slug) + '"><b>' + esc(r.name) + '</b>' + (r.on_watchlist ? '<span class="tag w">WATCH</span>' : '<span class="tag e">EARLY</span>') + '</td>' +
        '<td class="cat">' + esc(r.category || 'Uncategorised') + '</td>' +
        '<td class="ch">' + chains(r.chains, r.farm_chain) + '</td>' +
        '<td class="r num">' + money(r.tvl_usd) + '</td>' +
        '<td class="r num ' + cls(r.change_7d) + '">' + pct(r.change_7d) + '</td>' +
        '<td class="r num dim">' + age(r.age_days) + '</td>' +
        '<td class="r num dim">' + r.model.peer_multiple.toFixed(3) + '</td>' +
        '<td class="r"><div class="iv"><span class="num">' + money(r.implied_value_usd) + '</span><span class="meter"><i style="width:' + Math.min(100, w).toFixed(0) + '%"></i></span></div></td>' +
        // The farm chain already leads the Chains column (italic), so this cell is only the stake and hold.
        '<td class="farm r num" title="farm on ' + esc(r.farm_chain) + '">$' + r.capital_usd.toLocaleString('en-US') + ' · ' + r.hold_days + 'd</td></tr>';
    }).join('');
    return '<table><thead>' + head + '</thead><tbody>' + body + '</tbody></table>';
  }
  function liveTable(list) {
    var head = '<tr>' + th('Protocol', 'name', false, 1) + th('Category', 'category', false, 1) + '<th>Chains</th>' + th('TVL', 'tvl', true) + th('7d', 'chg', true) +
      th('Market cap', 'mcap', true) + th('Mcap ÷ TVL', 'mult', true) + th('Model value', 'model', true) + th('Model ÷ market', 'ratio', true) + '</tr>';
    var body = list.map(function (r) {
      var ratio = r.model_value_usd / r.mcap_usd;
      return '<tr data-slug="' + esc(r.slug) + '" aria-selected="' + (r.slug === S.p) + '">' +
        '<td class="nm"><b>' + esc(r.name) + '</b><span class="tag w">' + esc(r.symbol || 'TOKEN') + '</span><small>' + esc(r.slug) + '</small></td>' +
        '<td class="cat">' + esc(r.category || 'Uncategorised') + '</td><td class="ch">' + chains(r.chains) + '</td>' +
        '<td class="r num">' + money(r.tvl_usd) + '</td><td class="r num ' + cls(r.change_7d) + '">' + pct(r.change_7d) + '</td>' +
        '<td class="r num">' + money(r.mcap_usd) + '</td><td class="r num dim">' + (r.mcap_usd / r.tvl_usd).toFixed(3) + '</td>' +
        '<td class="r num">' + money(r.model_value_usd) + '</td><td class="r num ' + (ratio >= 1 ? 'up' : 'down') + '">' + x(ratio) + '</td></tr>';
    }).join('');
    return '<table><thead>' + head + '</thead><tbody>' + body + '</tbody></table>';
  }

  // ------------------------------------------------------------ detail
  function plan(r) {
    return '<h3>Farm plan <em>' + r.steps.length + ' steps · $' + r.capital_usd.toLocaleString('en-US') + ' on ' + esc(r.farm_chain) + ' for ' + r.hold_days + ' days</em></h3><ol class="steps">' +
      r.steps.map(function (s) { return '<li><p>' + esc(s[0]) + '.</p><div class="ct"><span>cost <b>' + esc(s[1]) + '</b></span><span>time <b>' + esc(s[2]) + '</b></span></div></li>'; }).join('') + '</ol>';
  }
  function mini(title, note, list, r) {
    return '<h3>' + title + ' <em>' + note + '</em></h3><table class="near"><tbody>' + list.map(function (n) {
      return '<tr data-slug="' + esc(n.slug) + '" aria-selected="' + (n.slug === r.slug) + '"><td class="num dim">' + n.rank + '</td><td>' + esc(n.name) + '</td><td class="dim">' + esc(n.category || '') + '</td><td class="r num ' + cls(n.change_7d) + '">' + pct(n.change_7d) + '</td><td class="r num">' + money(n.tvl_usd) + '</td><td class="r num">' + money(n.implied_value_usd) + '</td></tr>';
    }).join('') + '</tbody></table>';
  }
  // Where the protocol sits on the board, and how it compares with its own category.
  function near(r) {
    var from = Math.max(0, Math.min(r.rank - 5, rows.length - 9));
    return mini('Board neighbours', 'ranks ' + (from + 1) + '–' + (from + 9), rows.slice(from, from + 9), r);
  }
  function kin(r) {
    var cat = rows.filter(function (n) { return n.category === r.category; });
    var at = cat.indexOf(r), top = Math.max(0, Math.min(at - 3, cat.length - 7));
    return mini('Same category', cat.length + ' ' + esc(r.category || 'Uncategorised') + ' row' + (cat.length === 1 ? '' : 's') + ' on the board', cat.slice(top, top + 7), r);
  }
  function boardDetail(r, full) {
    var m = r.model;
    var share = (100 * r.implied_value_usd / r.tvl_usd).toFixed(1);
    return '<div class="d-head"><div><h2>' + esc(r.name) + (r.on_watchlist ? '<span class="tag w">WATCHLIST</span>' : '<span class="tag e">BELOW FLOOR</span>') + '</h2>' +
      '<p>' + esc(r.slug) + ' · ' + esc(r.category || 'Uncategorised') + ' · records no token</p></div><div class="d-rank">#' + r.rank + '</div>' +
      (full ? '<button class="expand" type="button" data-act="close">← Board</button>' : '<button class="expand" type="button" data-act="full">Full view</button>') + '</div>' +
      '<div class="d-value"><span>Implied token value if the record holds</span><b>' + whole(r.implied_value_usd) + '</b>' +
      '<div class="eq"><span>TVL</span><b>' + whole(r.tvl_usd) + '</b>' +
      '<span>× peer multiple · ' + esc(r.category || 'Uncategorised') + ', ' + m.peers + ' trading peer' + (m.peers === 1 ? '' : 's') + '</span><b>' + x(m.peer_multiple) + '</b>' +
      '<span>× growth · 7d TVL ' + pct(r.change_7d) + '</span><b>' + x(m.growth_mult) + '</b>' +
      '<span>× runway · ' + (r.age_days === null ? 'no listing date' : r.age_days + ' days listed, no token') + '</span><b>' + x(m.runway_mult) + '</b></div></div>' +
      '<div class="facts"><div><span>TVL</span><b>' + money(r.tvl_usd) + '</b></div><div><span>7d change</span><b class="' + cls(r.change_7d) + '">' + pct(r.change_7d) + '</b></div>' +
      '<div><span>Listed</span><b>' + (r.listed_at || 'n/a') + '</b></div><div><span>Value ÷ TVL</span><b>' + share + '%</b></div>' +
      '<div><span>Farm chain</span><b>' + esc(r.farm_chain) + '</b></div><div><span>Stake · hold</span><b>$' + r.capital_usd.toLocaleString('en-US') + ' · ' + r.hold_days + 'd</b></div></div>' +
      '<div class="chips">' + r.chains.map(function (c) { return '<span' + (c === r.farm_chain ? ' class="on"' : '') + '>' + esc(c) + '</span>'; }).join('') + '</div>' +
      (full ? near(r) : plan(r));
  }
  function fullView(r) {
    return '<div class="full"><div>' + boardDetail(r, true) + '</div><div>' + plan(r) + kin(r) + '</div></div>';
  }
  function liveDetail(r) {
    var ratio = r.model_value_usd / r.mcap_usd;
    return '<div class="d-head"><div><h2>' + esc(r.name) + '<span class="tag w">' + esc(r.symbol || 'TOKEN') + '</span></h2><p>' + esc(r.slug) + ' · ' + esc(r.category || 'Uncategorised') + ' · token trades</p></div></div>' +
      '<div class="d-value"><span>Market cap, as the snapshot records it</span><b>' + whole(r.mcap_usd) + '</b><div class="eq">' +
      '<span>The model, priced blind on this record</span><b>' + whole(r.model_value_usd) + '</b><span>Model ÷ market</span><b class="' + (ratio >= 1 ? 'up' : 'down') + '">' + x(ratio) + '</b>' +
      '<span>Market cap ÷ TVL</span><b>' + x(r.mcap_usd / r.tvl_usd) + '</b></div></div>' +
      '<div class="facts"><div><span>TVL</span><b>' + money(r.tvl_usd) + '</b></div><div><span>7d change</span><b class="' + cls(r.change_7d) + '">' + pct(r.change_7d) + '</b></div><div><span>Chains</span><b>' + r.chains.length + '</b></div></div>' +
      '<h3>No farm plan</h3><p class="dim">Its token already trades, so it sits outside the pre-token board. It is one of the ' + D.market_peers + ' trading comparables whose market-cap-to-TVL ratios set each category\'s peer multiple.</p>';
  }

  // ------------------------------------------------------------ views
  function renderModel() {
    var M = D.model;
    var body = D.multiples.map(function (m) {
      var n = rows.filter(function (r) { return (r.category || 'Uncategorised') === m.category; }).length;
      return '<tr><td>' + esc(m.category) + '</td><td class="r num">' + m.peers + '</td><td class="r num dim">' + (m.raw === null ? 'none' : m.raw.toFixed(3)) + '</td><td class="r num">' + x(m.multiple) + '</td><td class="r num">' + n + '</td></tr>';
    }).join('');
    return '<div class="model"><h3>How a row is valued <em>' + esc(D.model_version) + '</em></h3>' +
      '<pre>peer_multiple = exp((n·ln m_cat + ' + M.shrink_k + '·ln m_all) / (n + ' + M.shrink_k + '))   clamp ' + M.multiple_floor + '…' + M.multiple_cap + '\n' +
      'growth_mult   = 1 + clamp(change_7d, ' + M.growth_floor + ', ' + M.growth_cap + ') / 100 × ' + M.growth_weight + '\n' +
      'runway_mult   = ' + M.runway_floor + ' + ' + (1 - M.runway_floor) + ' × min(days listed, ' + M.runway_days + ') / ' + M.runway_days + '   (no listing date: ' + M.unknown_runway + ')\n' +
      'implied       = round(tvl_usd × peer_multiple × growth_mult × runway_mult)</pre>' +
      '<p>m_cat is the median market cap ÷ TVL of the snapshot protocols in that category whose token trades; m_all is the median over all ' + D.market_peers + ' of them (' + x(D.market_multiple) + '). A category with few trading peers leans on the market median, so one outlier cannot set a multiple. Growth rewards a rising seven-day TVL at half weight; runway rewards a longer record with no token. No protocol name appears anywhere in the model.</p>' +
      '<h3>Category multiples <em>for the ' + D.multiples.length + ' categories on the board</em></h3><table><thead><tr><th>Category</th><th class="r">Trading peers</th><th class="r">Raw median</th><th class="r">Peer multiple</th><th class="r">Board rows</th></tr></thead><tbody>' + body + '</tbody></table></div>';
  }

  function render() {
    document.querySelectorAll('#tabs button').forEach(function (b) { b.setAttribute('aria-selected', String(b.dataset.tab === S.tab)); });
    ['q', 'cat', 'chain', 'set', 'min'].forEach(function (k) {
      var el = $(k); el.value = String(S[k]); el.classList.toggle('on', S[k] !== '' && S[k] !== 0 && S[k] !== 'all');
    });
    var list = $('list'), detail = $('detail');
    if (S.tab === 'model') { $('main').classList.add('wide'); list.innerHTML = renderModel(); writeHash(); return; }
    var src = S.tab === 'live' ? D.live : rows;
    // Full view takes the whole width for one protocol; its neighbour rows select by click or j/k, filters aside.
    var one = S.tab === 'board' && S.v === 'full' ? rows.filter(function (r) { return r.slug === S.p; })[0] : null;
    $('main').classList.toggle('wide', !!one);
    if (one) { list.innerHTML = fullView(one); detail.innerHTML = ''; writeHash(); return; }
    S.v = '';
    var shown = sorted(src.filter(matches));
    if (!shown.some(function (r) { return r.slug === S.p; })) S.p = shown.length ? shown[0].slug : '';
    var label = S.tab === 'live' ? 'trading comparables, by market cap' : 'pre-token protocols, ranked by implied value';
    var total = shown.reduce(function (a, r) { return a + (r.implied_value_usd || r.mcap_usd); }, 0);
    list.innerHTML = '<div class="count"><span><b>' + shown.length + '</b> of ' + src.length + ' ' + label + '</span><span>' + (S.tab === 'live' ? 'market cap' : 'implied value') + ' shown <b class="num">' + money(total) + '</b></span></div>' +
      (shown.length ? (S.tab === 'live' ? liveTable(shown) : boardTable(shown)) : '<p class="empty">No protocol matches these filters. Reset to see the whole board.</p>');
    var sel = shown.filter(function (r) { return r.slug === S.p; })[0];
    detail.innerHTML = sel ? (S.tab === 'live' ? liveDetail(sel) : boardDetail(sel)) : '';
    writeHash();
  }

  // ------------------------------------------------------------ chrome
  function options(id, values, all) {
    $(id).innerHTML = '<option value="">' + all + '</option>' + values.map(function (v) { return '<option>' + esc(v) + '</option>'; }).join('');
  }
  function tally(key) {
    var n = {};
    rows.forEach(function (r) { (key === 'chains' ? r.chains : [r.category || 'Uncategorised']).forEach(function (v) { n[v] = (n[v] || 0) + 1; }); });
    return Object.keys(n).sort(function (a, b) { return n[b] - n[a] || a.localeCompare(b); });
  }
  options('cat', tally('category'), 'All categories');
  options('chain', tally('chains'), 'All chains');
  $('ver').textContent = D.model_version;
  $('src').textContent = 'snapshot ' + D.as_of + ' · ' + D.source;
  var watched = rows.filter(function (r) { return r.on_watchlist; }).length;
  var sum = rows.reduce(function (a, r) { return a + r.implied_value_usd; }, 0);
  var ratios = D.live.map(function (r) { return r.model_value_usd / r.mcap_usd; }).sort(function (a, b) { return a - b; });
  var kp = [
    [rows.length, 'protocols ranked, all pre-token'],
    [watched + ' / ' + D.watchlist_size, 'watchlist covered', true],
    [rows.length - watched, 'early rows below the ' + money(D.floor_usd) + ' floor'],
    [money(sum), 'implied value on the board'],
    [x(D.market_multiple), 'market mcap ÷ TVL, ' + D.market_peers + ' trading peers'],
    [x(ratios[ratios.length >> 1]), 'median model ÷ market on top ' + D.live.length + ' tokens'],
  ];
  $('kpis').innerHTML = kp.map(function (k) { return '<div class="kpi"><b class="' + (k[2] ? 'hit' : '') + '">' + k[0] + '</b><span>' + k[1] + '</span></div>'; }).join('');
  $('foot').textContent = 'Every figure is computed by lib/model.ts from the sealed snapshot (' + D.protocols_size + ' protocols, ' + D.as_of + '). Implied value is this board\'s own claim of what a token would be worth if the record held; it is not a forecast that a token will launch. "Records no token" means DefiLlama records none.';

  // ------------------------------------------------------------ events
  $('tabs').addEventListener('click', function (e) {
    var b = e.target.closest('button'); if (!b) return;
    S.tab = b.dataset.tab; S.sort = S.tab === 'live' ? 'mcap' : 'rank'; S.dir = S.tab === 'live' ? -1 : 1; S.p = ''; S.v = ''; render();
  });
  document.addEventListener('click', function (e) {
    var b = e.target.closest('button[data-act]');
    if (b) { S.v = b.dataset.act === 'full' ? 'full' : ''; render(); scrollTo(0, 0); }
  });
  $('list').addEventListener('click', function (e) {
    var b = e.target.closest('button[data-sort]');
    if (b) { var k = b.dataset.sort; S.dir = S.sort === k ? -S.dir : Number(b.dataset.first); S.sort = k; render(); return; }
    var tr = e.target.closest('tr[data-slug]');
    if (tr) { S.p = tr.dataset.slug; render(); }
  });
  ['cat', 'chain', 'set', 'min'].forEach(function (k) {
    $(k).addEventListener('change', function () { S[k] = k === 'min' ? Number(this.value) : this.value; render(); });
  });
  $('q').addEventListener('input', function () { S.q = this.value; render(); });
  $('reset').addEventListener('click', function () { S = Object.assign({}, DFLT, { tab: S.tab, sort: S.tab === 'live' ? 'mcap' : 'rank', dir: S.tab === 'live' ? -1 : 1 }); render(); });
  document.addEventListener('keydown', function (e) {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT' || (e.key !== 'j' && e.key !== 'k')) return;
    var trs = [].slice.call(document.querySelectorAll('tr[data-slug]'));
    var i = trs.findIndex(function (t) { return t.dataset.slug === S.p; }) + (e.key === 'j' ? 1 : -1);
    if (trs[i]) { S.p = trs[i].dataset.slug; render(); var row = document.querySelector('tr[aria-selected="true"]'); if (row) row.scrollIntoView({ block: 'nearest' }); }
  });
  window.addEventListener('hashchange', function () { readHash(); render(); });
  readHash();
  render();
})();
