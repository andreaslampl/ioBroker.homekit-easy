'use strict';

/* Setup page: pairing (QR code, PIN) and the device list with the object browser. */

const $ = id => document.getElementById(id);
let catalog = [];
let devices = [];
let saved = '[]';
let cameras = null;
const ICONS = { 'Licht & Strom': '💡', 'Fenster & Türen': '🚪', Klima: '🌡️', Sensoren: '📡', Sicherheit: '🛡️', Kameras: '📷', Sonstiges: '🔘' };

function esc(s) {
  return String(s === undefined || s === null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

async function api(path, options = {}) {
  const res = await fetch('api/' + path, { headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin', ...options });
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch (e) {
    data = text;
  }
  if (!res.ok) throw new Error((data && data.error) || text || 'HTTP ' + res.status);
  return data;
}

function toast(text, error) {
  const t = $('toast');
  t.textContent = text;
  t.className = error ? 'error' : '';
  t.style.display = text ? 'block' : 'none';
  clearTimeout(toast.timer);
  if (text) toast.timer = setTimeout(() => toast(''), error ? 6000 : 2500);
}

function typeOf(d) {
  return catalog.find(c => c.type === d.type);
}

function dirty() {
  const changed = JSON.stringify(devices) !== saved;
  $('save').disabled = !changed;
  return changed;
}

// ---------------- pairing ----------------

async function loadPairing() {
  const p = await api('pairing');
  if (p.alexa) renderAlexa(p.alexa);
  const box = $('pairing');
  $('pairState').textContent = p.paired ? 'Gekoppelt' : 'Nicht gekoppelt';
  $('pairState').className = 'badge' + (p.paired ? ' ok' : '');
  box.innerHTML = p.paired
    ? '<h2>Mit Apple Home gekoppelt</h2><div class="paired">✅</div><p class="muted">Bridge „' + esc(p.name) + '“ mit ' + p.devices + ' Gerät(en). Neue Geräte erscheinen nach dem Speichern automatisch in der Home-App.</p>' +
      '<p class="muted">Code: <b>' + esc(p.pincode) + '</b></p><button type="button" class="danger" id="reset">Kopplung zurücksetzen …</button>'
    : '<h2>Mit Apple Home koppeln</h2><div class="qr">' + p.qr + '</div><div class="pin">' + esc(p.pincode) + '</div>' +
      '<ol><li>iPhone: <b>Home-App</b> öffnen → <b>＋</b> → <b>Gerät hinzufügen</b>.</li><li>Den <b>QR-Code</b> scannen – oder „Weitere Optionen“ → „ioBroker“ wählen und den <b>Code</b> eingeben.</li>' +
      '<li>„Nicht zertifiziertes Gerät“ mit <b>Trotzdem hinzufügen</b> bestätigen.</li><li>Räume für die Geräte wählen – fertig.</li></ol>' +
      '<p class="muted" style="font-size:13px">Das iPhone muss im selben Netz sein wie der ioBroker.</p><button type="button" class="danger" id="reset">Neuen Code erzeugen …</button>';
  $('reset').onclick = async () => {
    if (!confirm('Kopplung wirklich zurücksetzen? Die Bridge muss danach in der Home-App neu hinzugefügt werden (vorher dort entfernen).')) return;
    await api('pairing/reset', { method: 'POST' });
    toast('Kopplung zurückgesetzt – neuer Code');
    loadPairing();
  };
}

function renderAlexa(a) {
  const box = $('alexa');
  const since = a.lastSeen ? Math.round((Date.now() - a.lastSeen) / 60000) : null;
  let status;
  if (a.error) status = '<p class="bad">Alexa kann nicht starten: ' + esc(a.error) + '. Siehe Anleitung (Port ' + a.port + ').</p>';
  else if (!a.devices) status = '<p class="muted">Noch kein Gerät für Alexa. Beim Gerät den Haken <b>„auch für Alexa“</b> setzen und speichern.</p>';
  else if (!a.running) status = '<p class="muted">Startet …</p>';
  else status = '<p class="ok">● bereit – ' + a.devices + ' Gerät(e) für Alexa</p>' +
    (since === null ? '<p class="muted">Noch kein Echo hat nachgefragt.</p>' : '<p class="muted">Echo zuletzt ' + (since < 1 ? 'gerade eben' : 'vor ' + since + ' min') + ' (' + esc(a.lastFrom) + ')</p>');
  box.innerHTML = '<h2>Alexa (Sprachsteuerung)</h2>' + status +
    '<ol><li>Beim Gerät <b>„auch für Alexa“</b> anhaken, speichern.</li><li>Zum Echo sagen: <b>„Alexa, suche Geräte“</b> (oder Alexa-App → Geräte → ＋ → Andere → Geräte suchen).</li>' +
    '<li>Dann z. B. „Alexa, Licht Wohnzimmer ein“, „… auf 30 Prozent“. Geräte erscheinen in der Alexa-App als Lampen und gehen auch in Routinen.</li></ol>' +
    '<p class="muted" style="font-size:13px">Läuft lokal ohne Skill und ohne Cloud. Rollläden: „ein“ = auf, „aus“ = zu, „auf 30 Prozent“ = 30 % offen.</p>';
}

// ---------------- device list ----------------

function mainState(d) {
  const t = typeOf(d);
  if (!t) return '';
  const f = t.fields.find(x => d[x[0]]);
  return f ? d[f[0]] : '';
}

function missing(d) {
  const t = typeOf(d);
  if (!t) return [];
  const out = t.fields.filter(f => f[3] && !d[f[0]]).map(f => f[1]);
  // e.g. blind: position or up/down, one of them is enough
  if (t.anyOf && !t.anyOf.some(k => d[k])) out.push(t.anyOf.map(k => t.fields.find(f => f[0] === k)[1].replace(/ \(.*\)$/, '')).join(' oder '));
  return out;
}

function renderList() {
  const list = $('list');
  list.textContent = '';
  $('count').textContent = devices.length ? devices.length + ' Gerät(e)' : '';
  if (!devices.length) {
    list.innerHTML = '<div class="empty">Noch keine Geräte. Mit „＋ Gerät“ das erste anlegen, z. B. ein Licht.</div>';
    return;
  }
  const groups = {};
  for (const d of devices) {
    const t = typeOf(d);
    const g = t ? t.group : 'Sonstiges';
    (groups[g] = groups[g] || []).push(d);
  }
  for (const g of Object.keys(ICONS).filter(k => groups[k])) {
    const h = document.createElement('div');
    h.className = 'group';
    h.textContent = g;
    list.appendChild(h);
    for (const d of groups[g]) {
      const t = typeOf(d);
      const row = document.createElement('div');
      row.className = 'dev' + (d.enabled === false ? ' off' : '');
      const miss = missing(d);
      row.innerHTML = '<span class="ico">' + (ICONS[g] || '🔘') + '</span><div class="txt"><div class="name">' + esc(d.name) + '</div><div class="sub">' +
        esc(t ? t.label : d.type) + ' · ' + esc(mainState(d)) + '</div>' + (miss.length ? '<div class="warn">fehlt: ' + esc(miss.join(', ')) + '</div>' : '') + '</div>' +
        (d.source ? '<span class="tag src" title="angelegt von ' + esc(d.source) + '">SmartView</span>' : '') + (d.alexa ? '<span class="tag">Alexa</span>' : '') + (d.enabled === false ? '<span class="muted">nicht in Home</span>' : '');
      row.onclick = () => edit(d);
      list.appendChild(row);
    }
  }
}

// ---------------- edit dialog ----------------

function field(box, label, input, help) {
  const l = document.createElement('label');
  l.textContent = label;
  box.appendChild(l);
  box.appendChild(input);
  if (help) {
    const h = document.createElement('div');
    h.className = 'help';
    h.textContent = help;
    box.appendChild(h);
  }
  return input;
}

function textInput(value, type = 'text') {
  const i = document.createElement('input');
  i.type = type;
  if (type === 'number') i.step = 'any';
  i.value = value === undefined || value === null ? '' : value;
  return i;
}

async function showValue(id, el, name) {
  el.textContent = '';
  if (!id) return;
  try {
    const v = (await api('values', { method: 'POST', body: JSON.stringify([id]) }))[id];
    el.textContent = (name ? name + ' · ' : '') + (v === null || v === undefined ? '⚠ kein Wert – ID prüfen' : 'aktuell: ' + (typeof v === 'object' ? JSON.stringify(v) : String(v)));
  } catch (e) {
    // ignore
  }
}

function stateField(box, label, value, forOutput) {
  const row = document.createElement('div');
  row.className = 'staterow';
  const input = textInput(value);
  input.placeholder = 'z. B. knx.0.EG.Licht.Wohnzimmer';
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.textContent = '📂 Auswählen';
  row.append(input, btn);
  field(box, label, row);
  const info = document.createElement('div');
  info.className = 'statename';
  box.appendChild(info);
  showValue(value, info);
  input.onchange = () => showValue(input.value.trim(), info);
  btn.onclick = async () => {
    const r = await Picker.open({ api, title: label, current: input.value.trim(), forOutput });
    if (r) {
      input.value = r.id;
      showValue(r.id, info, r.name);
    }
  };
  return input;
}

async function cameraField(box, label, value) {
  const s = document.createElement('select');
  s.innerHTML = '<option value="">(Kamera wählen)</option>';
  field(box, label, s, 'Die Kameras kommen aus dem livecam-Adapter.');
  try {
    cameras = cameras || (await api('cameras'));
  } catch (e) {
    cameras = [];
  }
  for (const c of cameras) {
    const o = document.createElement('option');
    o.value = c.id;
    o.textContent = c.name + ' (' + c.id + ')';
    s.appendChild(o);
  }
  s.value = value || '';
  return s;
}

function edit(original, isNew) {
  const d = JSON.parse(JSON.stringify(original));
  const ov = document.createElement('div');
  ov.className = 'overlay';
  const sh = document.createElement('div');
  sh.className = 'sheet form';
  ov.appendChild(sh);
  document.body.appendChild(ov);
  const close = () => ov.remove();
  const inputs = {};

  function build() {
    sh.innerHTML = '<h3><span class="grow">' + (isNew ? 'Gerät hinzufügen' : 'Gerät bearbeiten') + '</span><button type="button" data-x>✕</button></h3>';
    sh.querySelector('[data-x]').onclick = close;
    for (const k of Object.keys(inputs)) delete inputs[k];
    const sel = document.createElement('select');
    for (const g of Object.keys(ICONS)) {
      const og = document.createElement('optgroup');
      og.label = g;
      for (const c of catalog.filter(x => x.group === g)) {
        const o = document.createElement('option');
        o.value = c.type;
        o.textContent = c.label;
        og.appendChild(o);
      }
      if (og.children.length) sel.appendChild(og);
    }
    sel.value = d.type;
    if (d.source) {
      const h = document.createElement('div');
      h.className = 'help srcnote';
      h.textContent = 'Dieses Gerät kommt aus SmartView (' + d.source + ', Haken „auch in HomeKit“ an der Kachel). Name und Datenpunkte bitte dort ändern – Änderungen hier überschreibt SmartView beim nächsten Speichern. „In Apple Home anzeigen“ und „auch für Alexa“ bleiben so, wie du sie hier setzt.';
      sh.appendChild(h);
    }
    field(sh, 'Art', sel);
    sel.onchange = () => {
      collect();
      d.type = sel.value;
      build();
    };
    const t = typeOf(d);
    inputs.name = field(sh, t.alexa ? 'Name (für Siri und Alexa)' : 'Name in Apple Home', textInput(d.name), 'Siri' + (t.alexa ? ' und Alexa verstehen' : ' versteht') + ' diesen Namen, z. B. „Licht Wohnzimmer“.');
    for (const [key, label, mode] of t.fields) {
      if (mode === 'camera') cameraField(sh, label, d[key]).then(s => (inputs[key] = s));
      else inputs[key] = stateField(sh, label, d[key], mode === 'w');
    }
    for (const [key, label, kind, def] of t.options) {
      const value = d[key] === undefined ? def : d[key];
      if (kind === 'check') {
        const l = document.createElement('label');
        l.className = 'check';
        const i = document.createElement('input');
        i.type = 'checkbox';
        i.checked = Boolean(value);
        l.append(i, document.createTextNode(label));
        sh.appendChild(l);
        inputs[key] = i;
      } else if (kind.startsWith('select:')) {
        const s = document.createElement('select');
        for (const opt of kind.slice(7).split(';')) {
          const [v, txt] = opt.split('=');
          const o = document.createElement('option');
          o.value = v;
          o.textContent = txt;
          s.appendChild(o);
        }
        s.value = value || s.options[0].value;
        inputs[key] = field(sh, label, s);
      } else {
        inputs[key] = field(sh, label, textInput(value, kind === 'number' ? 'number' : 'text'));
      }
    }
    const en = document.createElement('label');
    en.className = 'check';
    const ei = document.createElement('input');
    ei.type = 'checkbox';
    ei.checked = d.enabled !== false;
    en.append(ei, document.createTextNode('in Apple Home anzeigen'));
    sh.appendChild(en);
    inputs.enabled = ei;
    if (t.alexa) {
      const al = document.createElement('label');
      al.className = 'check';
      const ai = document.createElement('input');
      ai.type = 'checkbox';
      ai.checked = Boolean(d.alexa);
      al.append(ai, document.createTextNode('auch für Alexa (Sprachsteuerung)'));
      sh.appendChild(al);
      inputs.alexa = ai;
      if (d.type === 'blind') {
        const h = document.createElement('div');
        h.className = 'help';
        h.textContent = 'Alexa sieht den Rollladen als Lampe: „ein“ = auf, „aus“ = zu, „auf 30 Prozent“ = 30 % offen.';
        sh.appendChild(h);
      }
    }

    const buttons = document.createElement('div');
    buttons.className = 'buttons';
    if (!isNew) {
      const del = document.createElement('button');
      del.type = 'button';
      del.className = 'danger';
      del.textContent = 'Löschen';
      del.onclick = () => {
        if (!confirm('„' + d.name + '“ löschen? Es verschwindet nach dem Speichern aus Apple Home.')) return;
        devices = devices.filter(x => x.id !== original.id);
        close();
        renderList();
        dirty();
      };
      buttons.appendChild(del);
    }
    const grow = document.createElement('span');
    grow.className = 'grow';
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.textContent = 'Abbrechen';
    cancel.onclick = close;
    const ok = document.createElement('button');
    ok.type = 'button';
    ok.className = 'primary';
    ok.textContent = 'Übernehmen';
    ok.onclick = () => {
      collect();
      const miss = missing(d);
      if (miss.length) return toast('Bitte noch ausfüllen: ' + miss.join(', '), true);
      const i = devices.findIndex(x => x.id === original.id);
      if (i >= 0) devices[i] = d;
      else devices.push(d);
      close();
      renderList();
      dirty();
    };
    buttons.append(grow, cancel, ok);
    sh.appendChild(buttons);
  }

  function collect() {
    const t = typeOf(d);
    const keep = new Set(['id', 'type', 'name', 'enabled', 'source', ...(t.alexa ? ['alexa'] : []), ...t.fields.map(f => f[0]), ...t.options.map(o => o[0])]);
    for (const k of Object.keys(d)) if (!keep.has(k)) delete d[k];
    for (const [key, input] of Object.entries(inputs)) {
      if (input.type === 'checkbox') d[key] = input.checked;
      else if (input.type === 'number') d[key] = input.value === '' ? undefined : Number(input.value);
      else d[key] = input.value.trim();
      if (d[key] === '' || d[key] === undefined || (key === 'alexa' && !d[key])) delete d[key];
    }
    d.name = d.name || t.label;
  }
  build();
}

function newId() {
  let i = 1;
  while (devices.some(d => d.id === 'd' + i)) i++;
  return 'd' + i;
}

async function save() {
  try {
    devices = await api('devices', { method: 'PUT', body: JSON.stringify(devices) });
    saved = JSON.stringify(devices);
    dirty();
    renderList();
    loadPairing();
    toast(devices.some(d => d.alexa) ? 'Gespeichert – für neue Alexa-Geräte „Alexa, suche Geräte“ sagen' : 'Gespeichert – Apple Home ist aktualisiert');
  } catch (e) {
    toast('Speichern fehlgeschlagen: ' + e.message, true);
  }
}

// ---------------- take over tiles from SmartView ----------------

async function fromSmartview() {
  if (dirty() && !confirm('Es gibt ungespeicherte Änderungen. Zuerst speichern?')) return;
  if (dirty()) await save();
  const ov = document.createElement('div');
  ov.className = 'overlay';
  const sh = document.createElement('div');
  sh.className = 'sheet form';
  sh.innerHTML = '<h3><span class="grow">Aus SmartView übernehmen</span><button type="button" data-x>✕</button></h3><p class="muted">Kacheln werden geladen …</p>';
  ov.appendChild(sh);
  document.body.appendChild(ov);
  const close = () => ov.remove();
  sh.querySelector('[data-x]').onclick = close;
  const res = await api('smartview').catch(e => ({ error: e.message }));
  sh.querySelector('p').remove();
  if (res.error) {
    sh.insertAdjacentHTML('beforeend', '<p class="warn">' + esc(res.error) + '</p>');
    return;
  }
  const intro = document.createElement('p');
  intro.className = 'help';
  intro.textContent = 'Die gewählten Kacheln bekommen in SmartView den Haken „auch in Apple Home“ und erscheinen hier als Geräte. Name und Datenpunkte kommen aus SmartView und werden dort geändert.';
  sh.appendChild(intro);
  const picks = [];
  let lastPage = null;
  for (const t of res.tiles) {
    if (t.pageName !== lastPage) {
      const h = document.createElement('div');
      h.className = 'group';
      h.textContent = t.pageName || t.page;
      sh.appendChild(h);
      lastPage = t.pageName;
    }
    const row = document.createElement('div');
    row.className = 'svrow';
    const l = document.createElement('label');
    l.className = 'check';
    const i = document.createElement('input');
    i.type = 'checkbox';
    i.checked = Boolean(t.homekit);
    i.disabled = Boolean(t.homekit);
    l.append(i, document.createTextNode(t.label + (t.homekit ? ' (schon in Apple Home)' : '')));
    row.appendChild(l);
    let sel = null;
    if (!t.homekit && t.choices.length > 1) {
      sel = document.createElement('select');
      for (const [v, txt] of t.choices) {
        const o = document.createElement('option');
        o.value = v;
        o.textContent = txt;
        sel.appendChild(o);
      }
      sel.value = t.default;
      row.appendChild(sel);
    }
    sh.appendChild(row);
    if (!t.homekit) picks.push({ i, sel, t });
  }
  if (!res.tiles.length) sh.insertAdjacentHTML('beforeend', '<p class="muted">In SmartView gibt es keine passenden Kacheln (Licht, Schalter, Dimmer, Rollladen, Heizung, Anzeige, Kamera).</p>');
  const buttons = document.createElement('div');
  buttons.className = 'buttons';
  const all = document.createElement('button');
  all.type = 'button';
  all.textContent = 'Alle';
  all.onclick = () => picks.forEach(p => (p.i.checked = true));
  const grow = document.createElement('span');
  grow.className = 'grow';
  const ok = document.createElement('button');
  ok.type = 'button';
  ok.className = 'primary';
  ok.textContent = 'Übernehmen';
  ok.onclick = async () => {
    const tiles = picks.filter(p => p.i.checked).map(p => ({ page: p.t.page, tile: p.t.tile, homekit: p.sel ? p.sel.value : p.t.default }));
    if (!tiles.length) return close();
    ok.disabled = true;
    const r = await api('smartview/link', { method: 'POST', body: JSON.stringify(tiles) }).catch(e => ({ error: e.message }));
    if (r.error) {
      toast(r.error, true);
      ok.disabled = false;
      return;
    }
    close();
    devices = await api('devices');
    saved = JSON.stringify(devices);
    renderList();
    loadPairing();
    toast(r.linked + ' Gerät(e) aus SmartView übernommen');
  };
  buttons.append(all, grow, ok);
  sh.appendChild(buttons);
}

(async () => {
  $('save').onclick = save;
  $('fromSv').onclick = fromSmartview;
  // the button only when SmartView is installed
  api('smartview').then(r => ($('fromSv').hidden = Boolean(r.missing))).catch(() => {});
  $('add').onclick = () => edit({ id: newId(), type: 'light', name: '', enabled: true }, true);
  window.addEventListener('beforeunload', e => {
    if (dirty()) {
      e.preventDefault();
      e.returnValue = '';
    }
  });
  try {
    catalog = await api('catalog');
    devices = await api('devices');
    saved = JSON.stringify(devices);
    renderList();
    await loadPairing();
    setInterval(() => !document.hidden && loadPairing().catch(() => {}), 10000);
  } catch (e) {
    toast('Verbindung zum Adapter fehlgeschlagen: ' + e.message, true);
  }
})();
