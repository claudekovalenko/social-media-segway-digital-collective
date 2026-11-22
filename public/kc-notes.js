(function () {
  if (window.__kcNotes) return;
  window.__kcNotes = true;

  var script = document.currentScript;
  var API = (script && script.dataset.api) || new URL(script ? script.src : '/notes.js', location.href).origin;
  var KEY = 'kc-notes-session';
  var params = new URLSearchParams(location.search);
  var codeParam = params.get('kcnotes');
  var focusId = (location.hash.match(/^#kcnote-(.+)$/) || [])[1];
  var adminHash = (location.hash.match(/^#kcadmin=([0-9]+\.[0-9a-f]+)$/) || [])[1];
  if (adminHash) history.replaceState(null, '', location.pathname + location.search);
  var session = null;
  var root, pinsLayer, mode = false, notes = [];
  try { session = JSON.parse(localStorage.getItem(KEY) || 'null'); } catch (e) {}

  if (codeParam === 'off') { try { localStorage.removeItem(KEY); } catch (e) {} return; }
  if (codeParam) {
    fetch(API + '/api/projects?code=' + encodeURIComponent(codeParam))
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (p) {
        if (!p) return;
        session = { code: codeParam, projectId: p.id, name: session && session.name || '' };
        if (adminHash) { try { sessionStorage.setItem('kc-notes-admin', adminHash); } catch (e) {} session.name = 'Ivan'; }
        save();
        start();
      })
      .catch(function () {});
    return;
  }
  if (session && session.projectId) start();

  function hasNotesKey() {
    try { var k = sessionStorage.getItem('kc-notes-admin'); return !!k && Number(k.split('.')[0]) > Date.now(); } catch (e) { return false; }
  }
  if (session && /^ivan$/i.test(session.name || '') && !adminHash && !hasNotesKey()) session.name = '';

  function save() { try { localStorage.setItem(KEY, JSON.stringify(session)); } catch (e) {} }

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  function pagePath() { return location.pathname + (location.pathname.endsWith('/') ? '' : ''); }

  function selectorFor(node) {
    var parts = [];
    while (node && node.nodeType === 1 && node !== document.body && parts.length < 8) {
      if (node.id && !/^kcn-/.test(node.id)) { parts.unshift('#' + CSS.escape(node.id)); break; }
      var i = 1, s = node;
      while ((s = s.previousElementSibling)) if (s.tagName === node.tagName) i++;
      parts.unshift(node.tagName.toLowerCase() + ':nth-of-type(' + i + ')');
      node = node.parentElement;
    }
    return parts.join(' > ');
  }


  function start() {
    var css = el('style');
    css.textContent = [
      '.kcn-root{all:initial;font-family:system-ui,-apple-system,sans-serif}',
      '.kcn-btn{position:fixed;right:18px;bottom:18px;z-index:2147483000;background:#4fd1a1;color:#0e1116;border:0;border-radius:24px;padding:11px 18px;font:700 14px system-ui,sans-serif;cursor:pointer;box-shadow:0 6px 20px rgba(0,0,0,.35)}',
      '.kcn-btn.on{background:#f59e0b}',
      '.kcn-count{margin-left:6px;background:#0e1116;color:#4fd1a1;border-radius:10px;padding:1px 7px;font-size:12px}',
      '.kcn-hint{position:fixed;left:50%;top:14px;transform:translateX(-50%);z-index:2147483000;background:#0e1116;color:#fff;border:1px solid #f59e0b;border-radius:8px;padding:8px 14px;font:13px system-ui,sans-serif}',
      '.kcn-pin{position:absolute;z-index:2147482000;width:26px;height:26px;margin:-26px 0 0 -4px;border-radius:13px 13px 13px 2px;background:#4fd1a1;color:#0e1116;font:700 12px system-ui,sans-serif;display:flex;align-items:center;justify-content:center;cursor:pointer;box-shadow:0 2px 8px rgba(0,0,0,.4);border:2px solid #0e1116}',
      '.kcn-pin.done{background:#8b949e}',
      '.kcn-pin.focus{outline:3px solid #f59e0b}',
      '.kcn-card{position:absolute;z-index:2147483001;width:280px;background:#161b22;color:#e6edf3;border:1px solid #30363d;border-radius:10px;padding:12px;font:13px/1.5 system-ui,sans-serif;box-shadow:0 10px 30px rgba(0,0,0,.5)}',
      '.kcn-card textarea,.kcn-card input{width:100%;box-sizing:border-box;background:#0e1116;color:#e6edf3;border:1px solid #30363d;border-radius:7px;padding:8px;font:13px system-ui,sans-serif;margin-bottom:8px;resize:vertical}',
      '.kcn-card textarea{min-height:70px}',
      '.kcn-row{display:flex;gap:6px;justify-content:flex-end;align-items:center}',
      '.kcn-row button{border-radius:6px;padding:5px 12px;font:600 12px system-ui,sans-serif;cursor:pointer;border:1px solid #30363d;background:none;color:#8b949e}',
      '.kcn-row button.primary{background:#4fd1a1;color:#0e1116;border-color:#4fd1a1}',
      '.kcn-meta{color:#8b949e;font-size:11px;margin-bottom:4px}',
      '.kcn-body{white-space:pre-wrap;word-break:break-word;margin-bottom:8px}',
      '.kcn-reply{border-top:1px solid #30363d;padding-top:6px;margin-top:6px}',
      '.kcn-err{color:#f97316;font-size:12px;margin:0 0 8px}',
      '.kcn-picking, .kcn-picking *{cursor:crosshair!important}'
    ].join('');
    document.head.appendChild(css);

    root = el('div', 'kcn-root'); root.id = 'kcn-root';
    pinsLayer = el('div'); pinsLayer.id = 'kcn-pins';
    root.appendChild(pinsLayer);
    var btn = el('button', 'kcn-btn'); btn.id = 'kcn-btn';
    btn.onclick = function (e) { e.stopPropagation(); setMode(!mode); };
    root.appendChild(btn);
    document.body.appendChild(root);
    renderBtn();

    document.addEventListener('click', onPick, true);
    document.addEventListener('keydown', function (e) {
      if (e.key !== 'Escape' || (!mode && !document.getElementById('kcn-card'))) return;
      e.stopPropagation(); setMode(false); closeCard();
    }, true);
    window.addEventListener('resize', placePins);
    load();
    setInterval(load, 15000);
  }

  function renderBtn() {
    var b = document.getElementById('kcn-btn');
    b.textContent = mode ? 'Click where your note goes  ✕' : 'Leave a note';
    b.classList.toggle('on', mode);
    var open = notes.filter(function (n) { return n.urgency !== 'done'; }).length;
    if (!mode && open) { var c = el('span', 'kcn-count', String(open)); b.appendChild(c); }
  }

  function setMode(on) {
    mode = on;
    document.documentElement.classList.toggle('kcn-picking', on);
    var hint = document.getElementById('kcn-hint');
    if (on && !hint) { hint = el('div', 'kcn-hint', 'Click anything on the page to leave a note there. Esc to cancel.'); hint.id = 'kcn-hint'; root.appendChild(hint); }
    if (!on && hint) hint.remove();
    renderBtn();
  }


  function onPick(e) {
    if (!mode) return;
    if (root.contains(e.target)) return;
    e.preventDefault(); e.stopPropagation();
    var target = e.target;
    var r = target.getBoundingClientRect();
    var anchor = {
      sel: selectorFor(target),
      fx: r.width ? (e.clientX - r.left) / r.width : 0,
      fy: r.height ? (e.clientY - r.top) / r.height : 0,
      px: e.pageX / document.documentElement.scrollWidth,
      py: e.pageY,
      vw: window.innerWidth
    };
    setMode(false);
    openComposer(e.pageX, e.pageY, anchor);
  }

  function closeCard() { var c = document.getElementById('kcn-card'); if (c) c.remove(); }

  function cardAt(x, y) {
    closeCard();
    var c = el('div', 'kcn-card'); c.id = 'kcn-card';
    var maxX = document.documentElement.scrollWidth - 300;
    c.style.left = Math.max(8, Math.min(x, maxX)) + 'px';
    c.style.top = (y + 8) + 'px';
    c.addEventListener('click', function (e) { e.stopPropagation(); });
    root.appendChild(c);
    return c;
  }

  function nameInput(c) {
    if (session.name) return null;
    var n = el('input'); n.placeholder = 'Your name';
    c.appendChild(n);
    return n;
  }

  function openComposer(x, y, anchor) {
    var c = cardAt(x, y);
    var n = nameInput(c);
    var t = el('textarea'); t.placeholder = 'What should change here? Links are fine.';
    c.appendChild(t);
    var row = el('div', 'kcn-row');
    var cancel = el('button', null, 'Cancel'); cancel.onclick = closeCard;
    var ok = el('button', 'primary', 'Save note');
    ok.onclick = function () {
      if (n) { if (!n.value.trim()) { n.focus(); return; } session.name = n.value.trim(); save(); }
      var text = t.value.trim(); if (!text) { t.focus(); return; }
      ok.disabled = true;
      post({
        plan_id: session.projectId, kind: 'sitenote', author_name: session.name, urgency: 'open',
        body: JSON.stringify({ text: text, url: location.origin + location.pathname, path: location.pathname, title: document.title, anchor: anchor })
      }).then(function () { closeCard(); load(); }, function (err) { failed(ok, err); });
    };
    row.appendChild(cancel); row.appendChild(ok); c.appendChild(row);
    (n || t).focus();
  }

  function headers() {
    var h = { 'Content-Type': 'application/json', 'X-Portal-Name': session.name || '' };
    var tok = null; try { tok = sessionStorage.getItem('kc-notes-admin'); } catch (e) {}
    if (tok && Number(tok.split('.')[0]) > Date.now()) h.Authorization = 'Bearer ' + tok;
    return h;
  }
  function post(data) {
    return fetch(API + '/api/posts', { method: 'POST', headers: headers(), body: JSON.stringify(data) })
      .then(function (r) {
        if (r.ok) return r;
        return r.json().catch(function () { return {}; }).then(function (d) { throw new Error(d.error || 'save failed'); });
      });
  }
  function failed(btn, err) {
    btn.disabled = false; btn.textContent = 'Try again';
    var msg = /Only Ivan/.test(err && err.message || '')
      ? 'To post as Ivan, open the site from the Site notes tab in the portal while signed in as Ivan.'
      : 'Could not save: ' + (err && err.message || 'network error');
    var c = document.getElementById('kcn-card');
    if (c) { var m = c.querySelector('.kcn-err') || el('div', 'kcn-err'); m.textContent = msg; c.insertBefore(m, c.lastChild); }
  }

  function load() {
    Promise.all([
      fetch(API + '/api/posts?plan_id=' + encodeURIComponent(session.projectId) + '&kind=sitenote').then(function (r) { return r.json(); }),
      fetch(API + '/api/posts?plan_id=' + encodeURIComponent(session.projectId) + '&kind=message').then(function (r) { return r.json(); })
    ]).then(function (res) {
      var replies = {};
      res[1].forEach(function (m) { if (m.task_id) (replies[m.task_id] = replies[m.task_id] || []).push(m); });
      notes = res[0].map(function (p) {
        var d = {}; try { d = JSON.parse(p.body); } catch (e) {}
        return { id: p.id, author: p.author_name, at: p.created_at, urgency: p.urgency, d: d, replies: replies[p.id] || [] };
      }).filter(function (n) { return n.d.path === location.pathname; });
      placePins();
      renderBtn();
      if (focusId) { var f = notes.find(function (n) { return n.id === focusId; }); if (f) { showNote(f, true); focusId = null; } }
    }).catch(function () {});
  }

  function pos(n) {
    var a = n.d.anchor || {};
    var node = null;
    try { node = a.sel ? document.querySelector(a.sel) : null; } catch (e) {}
    if (node && node.getClientRects().length) {
      var r = node.getBoundingClientRect();
      return { x: r.left + scrollX + r.width * (a.fx || 0), y: r.top + scrollY + r.height * (a.fy || 0) };
    }
    return { x: (a.px || 0) * document.documentElement.scrollWidth, y: a.py || 0 };
  }

  function placePins() {
    pinsLayer.textContent = '';
    notes.forEach(function (n, i) {
      var p = pos(n);
      var pin = el('div', 'kcn-pin' + (n.urgency === 'done' ? ' done' : ''), String(i + 1));
      pin.id = 'kcn-pin-' + n.id;
      pin.title = n.author + ': ' + (n.d.text || '');
      pin.style.left = p.x + 'px'; pin.style.top = p.y + 'px';
      pin.onclick = function (e) { e.stopPropagation(); showNote(n); };
      pinsLayer.appendChild(pin);
    });
  }

  function fmt(iso) {
    try { return new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }); } catch (e) { return ''; }
  }

  function showNote(n, scroll) {
    var p = pos(n);
    if (scroll) window.scrollTo({ top: Math.max(0, p.y - 200), behavior: 'smooth' });
    var pin = document.getElementById('kcn-pin-' + n.id); if (pin) pin.classList.add('focus');
    var c = cardAt(p.x, p.y);
    c.appendChild(el('div', 'kcn-meta', n.author + ' · ' + fmt(n.at) + (n.urgency === 'done' ? ' · resolved' : '')));
    c.appendChild(el('div', 'kcn-body', n.d.text || ''));
    n.replies.forEach(function (r) {
      var w = el('div', 'kcn-reply');
      w.appendChild(el('div', 'kcn-meta', r.author_name + ' · ' + fmt(r.created_at)));
      w.appendChild(el('div', 'kcn-body', r.body));
      c.appendChild(w);
    });
    var nIn = nameInput(c);
    var t = el('input'); t.placeholder = 'Reply…'; c.appendChild(t);
    var row = el('div', 'kcn-row');
    var close = el('button', null, 'Close'); close.onclick = function () { closeCard(); if (pin) pin.classList.remove('focus'); };
    var canDelete = (session.name && session.name.toLowerCase() === String(n.author).toLowerCase()) || hasNotesKey();
    var del = el('button', null, 'Delete');
    del.onclick = function () {
      if (!confirm('Delete this note and its replies?')) return;
      fetch(API + '/api/posts?id=' + encodeURIComponent(n.id), { method: 'DELETE', headers: headers() })
        .then(function (r) { if (!r.ok) throw new Error(); closeCard(); load(); })
        .catch(function () { del.textContent = 'Could not delete'; });
    };
    var res = el('button', null, n.urgency === 'done' ? 'Reopen' : 'Resolve');
    res.onclick = function () {
      fetch(API + '/api/posts?id=' + encodeURIComponent(n.id), { method: 'PATCH', headers: headers(), body: JSON.stringify({ urgency: n.urgency === 'done' ? 'open' : 'done' }) })
        .then(function () { closeCard(); load(); }, function () {});
    };
    var send = el('button', 'primary', 'Reply');
    send.onclick = function () {
      if (nIn) { if (!nIn.value.trim()) { nIn.focus(); return; } session.name = nIn.value.trim(); save(); }
      if (!t.value.trim()) { t.focus(); return; }
      post({ plan_id: session.projectId, task_id: n.id, kind: 'message', author_name: session.name, body: t.value.trim(), urgency: 'normal' })
        .then(function () { closeCard(); load(); }, function (err) { failed(send, err); });
    };
    t.onkeydown = function (e) { if (e.key === 'Enter') send.click(); };
    row.appendChild(close); if (canDelete) row.appendChild(del); row.appendChild(res); row.appendChild(send); c.appendChild(row);
  }
})();
