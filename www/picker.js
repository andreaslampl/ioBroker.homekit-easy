'use strict';

/*
 * Object browser for choosing an ioBroker data point (like the select dialog in Blockly/admin):
 * tree by ID segments with names of devices/channels, search, types, roles and current values.
 * (Same file as in ioBroker.logik and ioBroker.smartview.)
 * Picker.open({api, title, current, forOutput}) -> Promise<{id, name} | null>
 */

const Picker = (() => {
  let data = null; // {states, folders}
  let root = null;
  const expanded = new Set();

  function node(id, seg) {
    return { id, seg, children: new Map(), sorted: null, state: null, count: 0 };
  }

  function build() {
    root = node('', '');
    for (const s of data.states) {
      const parts = s.id.split('.');
      // adapter and instance together as first level ("hm-rpc.0", "0_userdata.0", "alias.0")
      const segs = parts.length > 2 ? [parts[0] + '.' + parts[1], ...parts.slice(2)] : parts;
      let n = root;
      let path = '';
      for (const seg of segs) {
        path = path ? path + '.' + seg : seg;
        if (!n.children.has(seg)) n.children.set(seg, node(path, seg));
        n.count++;
        n = n.children.get(seg);
      }
      n.state = s;
    }
  }

  const collator = new Intl.Collator('de', { numeric: true, sensitivity: 'base' });
  function children(n) {
    if (!n.sorted) n.sorted = [...n.children.values()].sort((a, b) => collator.compare(a.seg, b.seg));
    return n.sorted;
  }

  async function load(api, fresh) {
    data = await api('objects' + (fresh ? '?fresh=1' : ''));
    build();
  }

  function h(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  }

  function fmt(v) {
    if (v === null || v === undefined) return '';
    if (typeof v === 'boolean') return v ? 'true' : 'false';
    const t = typeof v === 'object' ? JSON.stringify(v) : String(v);
    return t.length > 30 ? t.slice(0, 29) + '…' : t;
  }

  function open({ api, title, current, forOutput }) {
    return new Promise(resolve => {
      const values = {};
      let selected = current || '';
      let query = '';

      const overlay = h('div', 'overlay');
      const box = h('div', 'picker');
      overlay.appendChild(box);
      const head = h('div', 'phead');
      head.appendChild(h('b', '', title));
      const close = h('button', 'pclose', '✕');
      close.type = 'button';
      close.title = 'Schließen (Esc)';
      head.appendChild(close);
      box.appendChild(head);

      const tools = h('div', 'ptools');
      const search = h('input');
      search.type = 'search';
      search.placeholder = 'Suchen: Name oder ID, z. B. „licht küche“';
      tools.appendChild(search);
      let onlyWritable = null;
      if (forOutput) {
        const lab = h('label', 'switch');
        onlyWritable = h('input');
        onlyWritable.type = 'checkbox';
        lab.appendChild(onlyWritable);
        lab.appendChild(document.createTextNode(' nur schreibbare'));
        lab.title = 'Datenpunkte ausblenden, die nur gelesen werden können';
        tools.appendChild(lab);
      }
      const reload = h('button', '', '⟳');
      reload.type = 'button';
      reload.title = 'Objektliste neu laden';
      tools.appendChild(reload);
      box.appendChild(tools);

      const table = h('div', 'ptable');
      box.appendChild(table);

      const foot = h('div', 'pfoot');
      const info = h('div', 'pinfo');
      foot.appendChild(info);
      const cancel = h('button', '', 'Abbrechen');
      cancel.type = 'button';
      const ok = h('button', 'primary', 'Übernehmen');
      ok.type = 'button';
      foot.appendChild(cancel);
      foot.appendChild(ok);
      box.appendChild(foot);
      document.body.appendChild(overlay);

      function stateOf(id) {
        return data && data.states.find(s => s.id === id);
      }

      function finish(result) {
        document.removeEventListener('keydown', onKey, true);
        overlay.remove();
        resolve(result);
      }

      function accept() {
        const s = stateOf(selected);
        if (!s) return;
        if (forOutput && !s.write && !confirm('„' + s.id + '“ ist nur lesbar. Trotzdem als Ausgang verwenden?')) return;
        finish({ id: s.id, name: s.name });
      }

      function updateInfo() {
        const s = stateOf(selected);
        info.textContent = '';
        if (!s) {
          info.appendChild(h('span', 'muted', 'Datenpunkt anklicken, Doppelklick übernimmt.'));
        } else {
          info.appendChild(h('div', 'pid', s.id));
          if (s.name) info.appendChild(h('div', 'muted', s.name));
        }
        ok.disabled = !s;
      }

      function visible(s) {
        return !(onlyWritable && onlyWritable.checked && !s.write);
      }

      function stateCells(row, s) {
        const name = h('span', 'pname', s.name);
        row.appendChild(name);
        row.appendChild(h('span', 'ptype', s.type + (s.unit ? ' [' + s.unit + ']' : '')));
        row.appendChild(h('span', 'prole', s.role));
        const val = h('span', 'pval', fmt(values[s.id]));
        val.dataset.val = s.id;
        row.appendChild(val);
        if (forOutput && !s.write) {
          row.classList.add('readonly');
          row.title = 'nur lesbar';
        }
        row.dataset.state = s.id;
        if (s.id === selected) row.classList.add('sel');
        row.onclick = () => {
          selected = s.id;
          for (const r of table.querySelectorAll('.prow.sel')) r.classList.remove('sel');
          row.classList.add('sel');
          updateInfo();
        };
        row.ondblclick = () => {
          selected = s.id;
          accept();
        };
      }

      function header(first) {
        const r = h('div', 'prow phdr');
        for (const t of [first, 'Name', 'Typ', 'Rolle', 'Wert']) r.appendChild(h('span', '', t));
        table.appendChild(r);
      }

      function countWritable(n) {
        if (!onlyWritable || !onlyWritable.checked) return n.count + (n.state ? 1 : 0);
        let c = n.state && n.state.write ? 1 : 0;
        for (const ch of n.children.values()) c += countWritable(ch);
        return c;
      }

      function renderTree(n, depth) {
        for (const ch of children(n)) {
          const isFolder = ch.children.size > 0;
          if (!isFolder && !visible(ch.state)) continue;
          if (isFolder && onlyWritable && onlyWritable.checked && !countWritable(ch)) continue;
          const row = h('div', 'prow');
          const first = h('span', 'pseg');
          first.style.paddingLeft = depth * 16 + 'px';
          const tog = h('span', 'ptog', isFolder ? (expanded.has(ch.id) ? '▾' : '▸') : '');
          first.appendChild(tog);
          first.appendChild(h('span', isFolder ? 'pfolder' : '', ch.seg));
          if (isFolder) first.appendChild(h('span', 'muted', ' (' + countWritable(ch) + ')'));
          row.appendChild(first);
          if (ch.state) {
            stateCells(row, ch.state);
            if (isFolder) tog.onclick = e => {
              e.stopPropagation();
              toggle(ch.id);
            };
          } else {
            row.appendChild(h('span', 'pname', data.folders[ch.id] || ''));
            row.classList.add('folder');
            row.onclick = () => toggle(ch.id);
          }
          table.appendChild(row);
          if (isFolder && expanded.has(ch.id)) renderTree(ch, depth + 1);
        }
      }

      function toggle(id) {
        if (expanded.has(id)) expanded.delete(id);
        else expanded.add(id);
        render();
      }

      const MAX = 300;
      function render() {
        const scroll = table.scrollTop;
        table.textContent = '';
        if (!data) {
          table.appendChild(h('div', 'pmsg muted', 'Objekte werden geladen …'));
          return;
        }
        const words = query.toLowerCase().split(/\s+/).filter(Boolean);
        if (words.length && query.trim().length >= 2) {
          header('ID');
          const hits = data.states.filter(s => visible(s) && words.every(w => s.id.toLowerCase().includes(w) || s.name.toLowerCase().includes(w)));
          for (const s of hits.slice(0, MAX)) {
            const row = h('div', 'prow');
            row.appendChild(h('span', 'pseg pidcol', s.id));
            stateCells(row, s);
            table.appendChild(row);
          }
          if (!hits.length) table.appendChild(h('div', 'pmsg muted', 'Nichts gefunden.'));
          if (hits.length > MAX) table.appendChild(h('div', 'pmsg muted', (hits.length - MAX) + ' weitere Treffer – Suche genauer eingeben.'));
        } else {
          header('Objekt');
          renderTree(root, 0);
          table.scrollTop = scroll;
        }
        loadValues();
      }

      let valueTimer = null;
      function loadValues() {
        clearTimeout(valueTimer);
        valueTimer = setTimeout(async () => {
          const ids = [...table.querySelectorAll('[data-val]')].map(e => e.dataset.val).filter(id => !(id in values)).slice(0, MAX);
          if (!ids.length) return;
          try {
            Object.assign(values, await api('values', { method: 'POST', body: JSON.stringify(ids) }));
          } catch (e) {
            return;
          }
          for (const e of table.querySelectorAll('[data-val]')) e.textContent = fmt(values[e.dataset.val]);
        }, 150);
      }

      function reveal(id) {
        // open the folders down to the current data point and scroll to it
        let n = root;
        while (id) {
          const next = [...n.children.values()].find(c => id === c.id || id.startsWith(c.id + '.'));
          if (!next || next.id === id) break;
          expanded.add(next.id);
          n = next;
        }
        render();
        const row = table.querySelector('.prow.sel');
        if (row) row.scrollIntoView({ block: 'center' });
      }

      function onKey(e) {
        if (e.key === 'Escape') {
          e.preventDefault();
          e.stopPropagation();
          finish(null);
        } else if (e.key === 'Enter' && selected && stateOf(selected)) {
          e.preventDefault();
          e.stopPropagation();
          accept();
        }
      }

      let searchTimer = null;
      search.oninput = () => {
        clearTimeout(searchTimer);
        searchTimer = setTimeout(() => {
          query = search.value;
          table.scrollTop = 0;
          render();
        }, 200);
      };
      if (onlyWritable) onlyWritable.onchange = () => render();
      reload.onclick = async () => {
        data = null;
        for (const k of Object.keys(values)) delete values[k];
        render();
        try {
          await load(api, true);
        } catch (e) {
          table.textContent = '';
          table.appendChild(h('div', 'pmsg error', 'Laden fehlgeschlagen: ' + e.message));
          return;
        }
        render();
      };
      close.onclick = () => finish(null);
      cancel.onclick = () => finish(null);
      ok.onclick = accept;
      overlay.onclick = e => {
        if (e.target === overlay) finish(null);
      };
      document.addEventListener('keydown', onKey, true);

      updateInfo();
      render();
      search.focus();
      (data ? Promise.resolve() : load(api, false))
        .then(() => {
          updateInfo();
          reveal(selected);
        })
        .catch(e => {
          table.textContent = '';
          table.appendChild(h('div', 'pmsg error', 'Laden fehlgeschlagen: ' + e.message));
        });
    });
  }

  return { open };
})();
