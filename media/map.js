/* global cytoscape, acquireVsCodeApi, renderMarkdown, escapeHtml */
(function () {
  const vscode = acquireVsCodeApi();
  window.addEventListener('error', (e) => vscode.postMessage({ type: 'webviewError', message: `${e.message} (map.js:${e.lineno}:${e.colno})` }));
  window.addEventListener('unhandledrejection', (e) => vscode.postMessage({ type: 'webviewError', message: String(e.reason) }));
  const h = (s) => escapeHtml(String(s ?? ''));

  const LAYER_COLORS = {
    Composition: '#9b8ad8', UI: '#4f9fe8', Controller: '#2bb3a3', Gameplay: '#f0a030', Service: '#5fbf6a',
    Data: '#e9727b', Infrastructure: '#9aa0a6', Mixed: '#c2a878', 'Third-party': '#6f6f6f', Other: '#b8b8b8',
  };
  const EDGE_TYPES = [
    { t: 'depends_on', label: 'depends on', color: '#5b9bd5' },
    { t: 'calls', label: 'calls', color: '#a0a0a0' },
    { t: 'references', label: 'references', color: '#7f8c8d' },
    { t: 'inherits', label: 'inherits', color: '#b07cd8' },
    { t: 'implements', label: 'implements', color: '#c39be3' },
    { t: 'creates', label: 'creates', color: '#26a69a' },
    { t: 'injects', label: 'injects', color: '#66bb6a' },
    { t: 'registers', label: 'registers (DI)', color: '#9b8ad8' },
    { t: 'subscribes_to', label: 'subscribes', color: '#e6b422' },
    { t: 'publishes', label: 'publishes', color: '#d4a017' },
  ];
  const EDGE_PRIORITY = ['inherits', 'implements', 'injects', 'creates', 'calls', 'depends_on', 'subscribes_to', 'publishes', 'registers', 'references'];
  const colorOfLayer = (l) => LAYER_COLORS[l] || LAYER_COLORS.Other;

  // ------------------------------------------------------------------ layout skeleton
  const app = document.getElementById('app');
  app.innerHTML = `
  <div class="toolbar">
    <span class="title" id="title">Architecture</span>
    <div class="search"><input id="q" type="text" placeholder="Search classes, methods, files, modules…" autocomplete="off"><div id="results" class="results hidden"></div></div>
    <div class="group">
      <button id="bModules" title="Level 1 — collapse to modules">Modules</button>
      <button id="bClasses" title="Level 2 — expand all modules into classes">Classes</button>
      <select id="layout" title="Layout"><option value="layered">Layered</option><option value="force">Force</option><option value="grid">Grid</option></select>
      <button id="bFit" title="Fit to screen">Fit</button>
      <button id="bFocus" title="Hide nodes unrelated to the selection">Focus</button>
      <button id="bPath" title="Trace a path: select a node, click this, then click a target node">Trace path</button>
      <button id="bClear" title="Clear highlights and focus">Clear</button>
    </div>
    <div class="group">
      <button id="bTrace" title="Trace how a feature flows through the code">Trace feature…</button>
      <button id="bChat" title="Ask questions about the codebase">Chat</button>
      <button id="bExplain" class="primary" title="AI explanation of the whole project">Explain project</button>
    </div>
    <span class="patterns" id="patterns"></span>
  </div>
  <div class="filters" id="filters"></div>
  <div class="main">
    <div id="cy"><div class="legend" id="legend"></div><div class="hint">click: inspect · double-click: expand · right-click: actions</div></div>
    <div id="resizer"></div>
    <div id="side">
      <div id="tabs"><button data-tab="inspector" class="on">Inspector</button><button data-tab="analysis">Analysis</button><button data-tab="ai">AI</button></div>
      <div class="pane" id="pane-inspector"><div class="empty">Select a module or class in the graph,<br>or search above.</div></div>
      <div class="pane hidden" id="pane-analysis"><div class="empty">Impact analysis, call flows and feature traces appear here.</div></div>
      <div class="pane hidden" id="pane-ai"><div class="empty">AI explanations appear here.<br><br>All AI answers are grounded in the static-analysis facts and cite files.</div></div>
    </div>
  </div>`;

  const $ = (id) => document.getElementById(id);
  const saved = vscode.getState() || {};
  const st = {
    data: null,
    expanded: new Set(saved.expanded || []),
    members: new Map(), // typeId -> {members, edges}
    expandedTypes: new Set(),
    edgeFilter: new Set(saved.edgeFilter || EDGE_TYPES.map((e) => e.t).filter((t) => t !== 'references' && t !== 'registers')),
    showThirdParty: saved.showThirdParty ?? false,
    layout: saved.layout || 'layered',
    focus: null,
    selected: null,
    pathMode: false,
    nodeById: new Map(),
    moduleById: new Map(),
    highlight: null,
  };
  $('layout').value = st.layout;
  const persist = () => vscode.setState({ expanded: [...st.expanded], edgeFilter: [...st.edgeFilter], showThirdParty: st.showThirdParty, layout: st.layout });

  // ------------------------------------------------------------------ tabs
  function showTab(name) {
    document.querySelectorAll('#tabs button').forEach((b) => b.classList.toggle('on', b.dataset.tab === name));
    ['inspector', 'analysis', 'ai'].forEach((t) => $('pane-' + t).classList.toggle('hidden', t !== name));
    const dot = document.querySelector(`#tabs button[data-tab="${name}"] .dot`);
    if (dot) dot.remove();
  }
  function markTab(name) {
    const b = document.querySelector(`#tabs button[data-tab="${name}"]`);
    if (b && !b.classList.contains('on') && !b.querySelector('.dot')) b.insertAdjacentHTML('beforeend', '<span class="dot"></span>');
  }
  document.querySelectorAll('#tabs button').forEach((b) => b.addEventListener('click', () => showTab(b.dataset.tab)));

  // side panel resize
  (() => {
    let drag = false;
    $('resizer').addEventListener('mousedown', () => (drag = true));
    window.addEventListener('mouseup', () => {
      if (drag) cy.resize();
      drag = false;
    });
    window.addEventListener('mousemove', (e) => {
      if (!drag) return;
      const w = Math.max(260, Math.min(window.innerWidth - 300, window.innerWidth - e.clientX));
      $('side').style.width = w + 'px';
    });
  })();

  // ------------------------------------------------------------------ filters & legend
  function renderFilters() {
    $('filters').innerHTML =
      'Edges: ' +
      EDGE_TYPES.map((e) => `<label><input type="checkbox" data-et="${e.t}" ${st.edgeFilter.has(e.t) ? 'checked' : ''}><span class="sw" style="background:${e.color}"></span>${e.label}</label>`).join('') +
      `<label style="margin-left:12px"><input type="checkbox" id="tp" ${st.showThirdParty ? 'checked' : ''}>third-party</label>`;
    $('filters').querySelectorAll('input[data-et]').forEach((cb) =>
      cb.addEventListener('change', () => {
        if (cb.checked) st.edgeFilter.add(cb.dataset.et);
        else st.edgeFilter.delete(cb.dataset.et);
        persist();
        render(false);
      }),
    );
    $('tp').addEventListener('change', (e) => {
      st.showThirdParty = e.target.checked;
      persist();
      render(true);
    });
  }
  function renderLegend() {
    const used = new Set(st.data.modules.map((m) => m.layer || 'Other'));
    st.data.nodes.forEach((n) => used.add(n.layer || 'Other'));
    $('legend').innerHTML = Object.keys(LAYER_COLORS).filter((l) => used.has(l)).map((l) => `<span><i style="background:${LAYER_COLORS[l]}"></i>${l}</span>`).join('');
  }

  // ------------------------------------------------------------------ cytoscape
  const css = (v, fb) => getComputedStyle(document.body).getPropertyValue(v).trim() || fb;
  const fg = css('--vscode-editor-foreground', '#ccc');
  const bg = css('--vscode-editor-background', '#1e1e1e');
  const cy = cytoscape({
    container: $('cy'),
    wheelSensitivity: 0.25,
    minZoom: 0.05,
    maxZoom: 3,
    boxSelectionEnabled: false,
    style: [
      { selector: 'node', style: { label: 'data(label)', color: fg, 'font-size': 11, 'text-valign': 'center', 'text-halign': 'center', 'text-wrap': 'wrap', 'text-max-width': 170, 'border-width': 1, 'border-color': 'data(color)' } },
      { selector: 'node.module', style: { shape: 'round-rectangle', width: 170, height: 56, 'background-color': 'data(color)', 'background-opacity': 0.22, 'border-width': 2, 'font-size': 13, 'font-weight': 600 } },
      { selector: 'node.module.expanded', style: { 'background-opacity': 0.05, 'border-style': 'dashed', 'text-valign': 'top', 'text-halign': 'center', 'text-margin-y': -4, padding: 18, 'font-size': 14 } },
      { selector: 'node.type', style: { shape: 'round-rectangle', width: (e) => Math.max(50, String(e.data('label')).length * 6.6 + 10), height: 30, padding: 8, 'background-color': 'data(color)', 'background-opacity': 0.9, color: '#111', 'font-size': 11, 'border-color': 'data(color)' } },
      { selector: 'node.type.interface', style: { 'background-opacity': 0.35, color: fg, 'border-style': 'dashed', 'border-width': 2 } },
      { selector: 'node.type.function', style: { shape: 'round-tag' } },
      { selector: 'node.type.enum, node.type.type', style: { 'background-opacity': 0.45, color: fg } },
      { selector: 'node.type.expandedType', style: { 'background-opacity': 0.12, color: fg, 'text-valign': 'top', 'text-margin-y': -3, padding: 10, 'font-weight': 600 } },
      { selector: 'node.member', style: { shape: 'rectangle', width: (e) => Math.max(40, String(e.data('label')).length * 6 + 6), height: 20, padding: 4, 'background-color': bg, 'border-color': '#888', 'font-size': 10, color: fg } },
      { selector: 'node.f-error', style: { 'border-color': '#f14c4c', 'border-width': 3 } },
      { selector: 'node.f-warning', style: { 'border-color': '#e0b000', 'border-width': 3 } },
      { selector: 'node:selected', style: { 'overlay-color': '#3794ff', 'overlay-opacity': 0.25, 'overlay-padding': 4 } },
      { selector: 'edge', style: { width: 'mapData(w, 1, 40, 1.2, 6)', 'curve-style': 'bezier', 'target-arrow-shape': 'triangle', 'arrow-scale': 0.9, 'line-color': 'data(color)', 'target-arrow-color': 'data(color)', opacity: 0.75, label: 'data(label)', 'font-size': 9, color: fg, 'text-background-color': bg, 'text-background-opacity': 0.8, 'text-background-padding': 1 } },
      { selector: 'edge.inherits, edge.implements', style: { 'target-arrow-shape': 'triangle-backcurve', 'target-arrow-fill': 'hollow' } },
      { selector: 'edge.implements, edge.subscribes_to, edge.publishes, edge.registers', style: { 'line-style': 'dashed' } },
      { selector: 'edge.call', style: { width: 1.2, 'line-color': '#a0a0a0', 'target-arrow-color': '#a0a0a0', 'line-style': 'solid' } },
      { selector: '.faded', style: { opacity: 0.1 } },
      { selector: 'edge.hl-out', style: { 'line-color': '#3794ff', 'target-arrow-color': '#3794ff', opacity: 1, width: 3, 'z-index': 10 } },
      { selector: 'edge.hl-in', style: { 'line-color': '#f39c12', 'target-arrow-color': '#f39c12', opacity: 1, width: 3, 'z-index': 10 } },
      { selector: 'node.hl-out', style: { 'border-color': '#3794ff', 'border-width': 3 } },
      { selector: 'node.hl-in', style: { 'border-color': '#f39c12', 'border-width': 3 } },
      { selector: '.path', style: { 'line-color': '#ff4d6d', 'target-arrow-color': '#ff4d6d', 'border-color': '#ff4d6d', 'border-width': 4, width: 4, opacity: 1, 'z-index': 20 } },
      { selector: 'node.mark', style: { 'border-color': '#ff4d6d', 'border-width': 3 } },
    ],
  });

  const moduleRank = (m) => {
    if (!m) return 3.5;
    if (m.layer === 'Third-party') return 7;
    const l = st.data.layers.find((x) => x.name === m.layer);
    return l ? l.rank : 3.5;
  };
  const isThirdParty = (moduleId) => st.moduleById.get(moduleId)?.layer === 'Third-party';

  /** Which visible graph node represents a type id under the current expansion. */
  function visibleOf(id) {
    const n = st.nodeById.get(id);
    if (!n) return null;
    if (!n.module || !st.moduleById.has(n.module)) return null;
    if (!st.showThirdParty && isThirdParty(n.module)) return null;
    return st.expanded.has(n.module) ? id : 'm:' + n.module;
  }

  function buildElements() {
    const els = [];
    const d = st.data;
    const visibleNodes = new Set();
    for (const m of d.modules) {
      if (!st.showThirdParty && m.layer === 'Third-party') continue;
      const exp = st.expanded.has(m.id);
      els.push({ data: { id: 'm:' + m.id, label: exp ? `${m.name}` : `${m.name}\n${m.symbols} symbols`, color: colorOfLayer(m.layer || 'Other'), kind: 'module', moduleId: m.id }, classes: 'module' + (exp ? ' expanded' : '') });
      visibleNodes.add('m:' + m.id);
    }
    for (const n of d.nodes) {
      if (!n.module || !st.expanded.has(n.module)) continue;
      if (!st.showThirdParty && isThirdParty(n.module)) continue;
      const fsev = d.findingsBySymbol[n.id];
      const expT = st.expandedTypes.has(n.id) && st.members.has(n.id);
      els.push({
        data: { id: n.id, parent: 'm:' + n.module, label: n.name, color: colorOfLayer(n.layer || 'Other'), kind: 'type', file: n.file, line: n.line },
        classes: ['type', n.kind, fsev ? 'f-' + fsev : '', expT ? 'expandedType' : ''].join(' '),
      });
      visibleNodes.add(n.id);
      if (expT) {
        for (const mem of st.members.get(n.id).members) {
          els.push({ data: { id: mem.id, parent: n.id, label: mem.name + (mem.kind === 'property' ? '' : '()'), kind: 'member', file: mem.file, line: mem.line, color: '#888' }, classes: 'member' });
          visibleNodes.add(mem.id);
        }
      }
    }
    // aggregated dependency edges
    const agg = new Map();
    for (const e of d.edges) {
      const types = e.types.filter((t) => st.edgeFilter.has(t));
      if (!types.length) continue;
      const a = visibleOf(e.s);
      const b = visibleOf(e.t);
      if (!a || !b || a === b) continue;
      // avoid drawing type -> its own module compound, etc.
      const k = a + '|' + b;
      let g = agg.get(k);
      if (!g) agg.set(k, (g = { a, b, types: new Set(), w: 0 }));
      types.forEach((t) => g.types.add(t));
      g.w += e.w;
    }
    for (const g of agg.values()) {
      const types = [...g.types];
      const main = EDGE_PRIORITY.find((t) => g.types.has(t)) || types[0];
      const color = EDGE_TYPES.find((x) => x.t === main)?.color || '#999';
      const moduleLevel = g.a.startsWith('m:') && g.b.startsWith('m:');
      els.push({ data: { id: 'e:' + g.a + '|' + g.b, source: g.a, target: g.b, w: g.w, color, types: types.join(','), label: moduleLevel ? String(g.w) : '' }, classes: main });
    }
    // member-level call edges
    if (st.edgeFilter.has('calls')) {
      const seen = new Set();
      for (const [, info] of st.members) {
        for (const e of info.edges) {
          const a = visibleNodes.has(e.s) ? e.s : visibleOf(e.sOwner);
          const b = visibleNodes.has(e.t) ? e.t : visibleOf(e.tOwner);
          if (!a || !b || a === b || !(visibleNodes.has(e.s) || visibleNodes.has(e.t))) continue;
          const k = 'c:' + a + '|' + b;
          if (seen.has(k)) continue;
          seen.add(k);
          els.push({ data: { id: k, source: a, target: b, w: 1, color: '#a0a0a0', label: '' }, classes: 'call' });
        }
      }
    }
    return els;
  }

  function layeredPositions() {
    const pos = {};
    const rows = new Map();
    for (const m of st.data.modules) {
      if (!st.showThirdParty && m.layer === 'Third-party') continue;
      const r = moduleRank(m);
      if (!rows.has(r)) rows.set(r, []);
      rows.get(r).push(m);
    }
    let y = 0;
    for (const r of [...rows.keys()].sort((a, b) => a - b)) {
      const mods = rows.get(r).sort((a, b) => b.symbols - a.symbols);
      const boxes = mods.map((m) => {
        if (!st.expanded.has(m.id)) return { m, w: 190, h: 70, children: [] };
        const kids = st.data.nodes.filter((n) => n.module === m.id);
        // order children by layer rank so the inside of a module also reads top-down
        kids.sort((a, b) => (rankOfLayer(a.layer) - rankOfLayer(b.layer)) || a.name.localeCompare(b.name));
        const cols = Math.max(1, Math.ceil(Math.sqrt(kids.length * 1.6)));
        const cellW = 200;
        const rowsH = [];
        kids.forEach((k, i) => {
          const row = Math.floor(i / cols);
          const hgt = st.expandedTypes.has(k.id) && st.members.has(k.id) ? 50 + st.members.get(k.id).members.length * 26 : 56;
          rowsH[row] = Math.max(rowsH[row] || 0, hgt);
        });
        return { m, w: Math.min(kids.length, cols) * cellW + 40, h: rowsH.reduce((a, b) => a + b, 0) + 60, children: kids, cols, cellW, rowsH };
      });
      const totalW = boxes.reduce((a, b) => a + b.w + 60, -60);
      let x = -totalW / 2;
      const rowH = Math.max(...boxes.map((b) => b.h));
      for (const b of boxes) {
        const cx = x + b.w / 2;
        if (!b.children.length) pos['m:' + b.m.id] = { x: cx, y: y + rowH / 2 };
        else {
          let yy = y + 40;
          b.children.forEach((k, i) => {
            const col = i % b.cols;
            const row = Math.floor(i / b.cols);
            if (col === 0 && i > 0) yy += b.rowsH[row - 1];
            const kx = x + 20 + col * b.cellW + b.cellW / 2;
            const ky = yy + b.rowsH[row] / 2;
            if (st.expandedTypes.has(k.id) && st.members.has(k.id)) {
              const mems = st.members.get(k.id).members;
              mems.forEach((mm, j) => (pos[mm.id] = { x: kx, y: ky - (mems.length * 26) / 2 + j * 26 + 18 }));
            } else pos[k.id] = { x: kx, y: ky };
          });
        }
        x += b.w + 60;
      }
      y += rowH + 110;
    }
    return pos;
  }
  const rankOfLayer = (l) => {
    const x = st.data.layers.find((q) => q.name === l);
    return x ? x.rank : 3.5;
  };

  function runLayout(fit) {
    let opts;
    if (st.layout === 'layered') {
      const pos = layeredPositions();
      opts = { name: 'preset', positions: (n) => pos[n.id()] || undefined, fit, padding: 40, animate: false };
    } else if (st.layout === 'force') {
      opts = { name: 'cose', fit, padding: 40, animate: false, nodeRepulsion: () => 9000, idealEdgeLength: () => 90, nestingFactor: 0.9, gravity: 0.6, numIter: 1200, randomize: true };
    } else {
      opts = { name: 'grid', fit, padding: 40, avoidOverlap: true };
    }
    cy.layout(opts).run();
  }

  function render(fit) {
    if (!st.data) return;
    const zoom = cy.zoom();
    const pan = cy.pan();
    cy.startBatch();
    cy.elements().remove();
    cy.add(buildElements());
    cy.endBatch();
    runLayout(fit);
    if (!fit) {
      cy.zoom(zoom);
      cy.pan(pan);
    }
    applyFocus();
    if (st.selected && cy.getElementById(st.selected).nonempty()) highlightNeighborhood(cy.getElementById(st.selected));
    if (st.highlight) applyHighlightSet(st.highlight, false);
    vscode.postMessage({ type: 'rendered', nodes: cy.nodes().length, edges: cy.edges().length });
  }

  // ------------------------------------------------------------------ highlighting
  function clearHighlight() {
    cy.elements().removeClass('faded hl-in hl-out path mark');
  }
  function highlightNeighborhood(node) {
    clearHighlight();
    if (!node || node.empty()) return;
    const out = node.outgoers('edge');
    const inc = node.incomers('edge');
    out.addClass('hl-out');
    out.targets().addClass('hl-out');
    inc.addClass('hl-in');
    inc.sources().addClass('hl-in');
  }
  function applyFocus() {
    if (!st.focus) return;
    const n = cy.getElementById(st.focus);
    if (n.empty()) return;
    const keep = n.closedNeighborhood().union(n.ancestors()).union(n.descendants());
    const keepWithParents = keep.union(keep.nodes().ancestors());
    cy.elements().not(keepWithParents).addClass('faded');
  }
  function applyHighlightSet(ids, expand) {
    const set = new Set(ids);
    if (expand) {
      let changed = false;
      for (const id of ids) {
        const n = st.nodeById.get(id);
        if (n && n.module && !st.expanded.has(n.module)) {
          st.expanded.add(n.module);
          changed = true;
        }
      }
      if (changed) {
        persist();
        st.highlight = ids;
        render(true);
        return;
      }
    }
    clearHighlight();
    cy.elements().addClass('faded');
    cy.nodes().forEach((n) => {
      if (set.has(n.id())) {
        n.removeClass('faded').addClass('mark');
        n.ancestors().removeClass('faded');
      }
    });
    cy.edges().forEach((e) => {
      if (set.has(e.source().id()) && set.has(e.target().id())) e.removeClass('faded').addClass('path');
    });
  }

  function selectNode(id, center) {
    const n = cy.getElementById(id);
    if (n.empty()) return;
    cy.$(':selected').unselect();
    n.select();
    st.selected = id;
    highlightNeighborhood(n);
    if (center) cy.animate({ center: { eles: n }, zoom: Math.max(cy.zoom(), 0.9) }, { duration: 250 });
  }

  function revealSymbol(id, inspect) {
    const n = st.nodeById.get(id);
    if (!n) return;
    if (n.module && !st.expanded.has(n.module)) {
      st.expanded.add(n.module);
      persist();
      render(false);
    }
    selectNode(id, true);
    if (inspect) vscode.postMessage({ type: 'inspect', id });
  }

  // ------------------------------------------------------------------ graph events
  cy.on('tap', 'node', (evt) => {
    hideCtx();
    const n = evt.target;
    const d = n.data();
    if (st.pathMode && st.selected && st.selected !== n.id()) {
      st.pathMode = false;
      $('bPath').classList.remove('active');
      const from = st.selected.startsWith('m:') ? null : st.selected;
      if (from && d.kind === 'type') vscode.postMessage({ type: 'path', from, to: n.id() });
      else toast('Pick two classes (expand modules first) to trace a path');
      return;
    }
    st.selected = n.id();
    highlightNeighborhood(n);
    if (d.kind === 'module') vscode.postMessage({ type: 'inspect', moduleId: d.moduleId });
    else if (d.kind === 'type') vscode.postMessage({ type: 'inspect', id: n.id() });
    else if (d.kind === 'member') vscode.postMessage({ type: 'inspect', id: n.id() });
  });
  cy.on('tap', (evt) => {
    if (evt.target === cy) {
      hideCtx();
      st.selected = null;
      clearHighlight();
      applyFocus();
    }
  });
  cy.on('dbltap', 'node', (evt) => {
    const n = evt.target;
    const d = n.data();
    if (d.kind === 'module') {
      if (st.expanded.has(d.moduleId)) st.expanded.delete(d.moduleId);
      else st.expanded.add(d.moduleId);
      persist();
      render(false);
      selectNode(n.id(), true);
    } else if (d.kind === 'type') toggleMembers(n.id());
    else if (d.kind === 'member') vscode.postMessage({ type: 'open', file: d.file, line: d.line });
  });
  function toggleMembers(id) {
    if (st.expandedTypes.has(id)) {
      st.expandedTypes.delete(id);
      render(false);
    } else {
      st.expandedTypes.add(id);
      if (st.members.has(id)) render(false);
      else vscode.postMessage({ type: 'members', id });
    }
  }

  // context menu
  let ctxEl = null;
  function hideCtx() {
    if (ctxEl) ctxEl.remove();
    ctxEl = null;
  }
  cy.on('cxttap', 'node', (evt) => {
    hideCtx();
    const n = evt.target;
    const d = n.data();
    const items = [];
    if (d.kind === 'module') {
      items.push([st.expanded.has(d.moduleId) ? 'Collapse module' : 'Expand module', () => n.emit('dbltap')]);
      items.push(['Explain module (AI)', () => vscode.postMessage({ type: 'explain', moduleId: d.moduleId })]);
      items.push(['Focus', () => setFocus(n.id())]);
    } else {
      const id = n.id();
      items.push(['Open file', () => vscode.postMessage({ type: 'open', file: d.file, line: d.line })]);
      items.push(['Inspect', () => vscode.postMessage({ type: 'inspect', id })]);
      items.push(['Explain (AI)', () => vscode.postMessage({ type: 'explain', id })]);
      items.push(null);
      if (d.kind === 'type') items.push([st.expandedTypes.has(id) ? 'Hide methods' : 'Show methods', () => toggleMembers(id)]);
      items.push(['Show callers', () => vscode.postMessage({ type: 'callTree', id, direction: 'callers' })]);
      items.push(['Show callees', () => vscode.postMessage({ type: 'callTree', id, direction: 'callees' })]);
      items.push(['Find references', () => vscode.postMessage({ type: 'findRefs', id })]);
      items.push(['Analyze impact (what could break?)', () => vscode.postMessage({ type: 'impact', id })]);
      items.push(null);
      items.push(['Focus (hide unrelated)', () => setFocus(id)]);
      items.push(['Trace path from here…', () => {
        selectNode(id);
        st.pathMode = true;
        $('bPath').classList.add('active');
        toast('Now click the target class');
      }]);
    }
    ctxEl = document.createElement('div');
    ctxEl.className = 'ctx';
    ctxEl.innerHTML = items.map((it, i) => (it ? `<div data-i="${i}">${h(it[0])}</div>` : '<hr>')).join('');
    const rp = evt.renderedPosition;
    ctxEl.style.left = rp.x + 'px';
    ctxEl.style.top = rp.y + 'px';
    $('cy').appendChild(ctxEl);
    ctxEl.querySelectorAll('div[data-i]').forEach((el) =>
      el.addEventListener('click', () => {
        const it = items[+el.dataset.i];
        hideCtx();
        it[1]();
      }),
    );
  });

  function setFocus(id) {
    st.focus = id;
    $('bFocus').classList.add('active');
    clearHighlight();
    applyFocus();
    const n = cy.getElementById(id);
    if (n.nonempty()) cy.animate({ fit: { eles: n.closedNeighborhood(), padding: 60 } }, { duration: 250 });
  }

  // ------------------------------------------------------------------ toolbar
  $('bModules').addEventListener('click', () => {
    st.expanded.clear();
    st.expandedTypes.clear();
    persist();
    render(true);
  });
  $('bClasses').addEventListener('click', () => {
    if (st.data.nodes.length > 1500) toast(`Expanding ${st.data.nodes.length} classes — this may take a moment`);
    st.data.modules.forEach((m) => (st.showThirdParty || m.layer !== 'Third-party') && st.expanded.add(m.id));
    persist();
    render(true);
  });
  $('layout').addEventListener('change', (e) => {
    st.layout = e.target.value;
    persist();
    render(true);
  });
  $('bFit').addEventListener('click', () => cy.fit(undefined, 40));
  $('bFocus').addEventListener('click', () => {
    if (st.focus) {
      st.focus = null;
      $('bFocus').classList.remove('active');
      clearHighlight();
    } else if (st.selected) setFocus(st.selected);
    else toast('Select a node first');
  });
  $('bPath').addEventListener('click', () => {
    if (!st.selected) return toast('Select the start class first');
    st.pathMode = !st.pathMode;
    $('bPath').classList.toggle('active', st.pathMode);
    if (st.pathMode) toast('Now click the target class');
  });
  $('bClear').addEventListener('click', () => {
    st.focus = null;
    st.highlight = null;
    st.pathMode = false;
    $('bFocus').classList.remove('active');
    $('bPath').classList.remove('active');
    clearHighlight();
  });
  $('bTrace').addEventListener('click', () => vscode.postMessage({ type: 'trace' }));
  $('bChat').addEventListener('click', () => vscode.postMessage({ type: 'chat' }));
  $('bExplain').addEventListener('click', () => vscode.postMessage({ type: 'explainProject' }));

  // search
  let searchTimer;
  let hits = [];
  let hitSel = -1;
  $('q').addEventListener('input', () => {
    clearTimeout(searchTimer);
    const q = $('q').value.trim();
    if (!q) return $('results').classList.add('hidden');
    searchTimer = setTimeout(() => vscode.postMessage({ type: 'search', query: q }), 120);
  });
  $('q').addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      hitSel = Math.max(0, Math.min(hits.length - 1, hitSel + (e.key === 'ArrowDown' ? 1 : -1)));
      renderHits();
      e.preventDefault();
    } else if (e.key === 'Enter') {
      if (hits.length) chooseHit(hits[Math.max(0, hitSel)]);
    } else if (e.key === 'Escape') $('results').classList.add('hidden');
  });
  document.addEventListener('click', (e) => {
    if (!e.target.closest('.search')) $('results').classList.add('hidden');
    if (!e.target.closest('.ctx')) hideCtx();
  });
  function renderHits() {
    $('results').innerHTML = hits.length
      ? hits.map((x, i) => `<div class="hit ${i === hitSel ? 'sel' : ''}" data-i="${i}"><span class="k">${h(x.kind === 'symbol' ? x.detail.split(' · ')[0] : x.kind)}</span><span>${h(x.label)}</span><span class="d">${h(x.kind === 'symbol' ? x.detail.split(' · ')[1] : x.detail)}</span></div>`).join('')
      : '<div class="hit"><span class="d">No matches</span></div>';
    $('results').classList.remove('hidden');
    $('results').querySelectorAll('.hit[data-i]').forEach((el) => el.addEventListener('click', () => chooseHit(hits[+el.dataset.i])));
  }
  function chooseHit(x) {
    $('results').classList.add('hidden');
    if (x.kind === 'module') {
      selectNode('m:' + x.moduleId, true);
      vscode.postMessage({ type: 'inspect', moduleId: x.moduleId });
    } else if (x.kind === 'file') vscode.postMessage({ type: 'open', file: x.file, line: 1 });
    else {
      const n = st.nodeById.get(x.id);
      if (n) revealSymbol(x.id, true);
      else vscode.postMessage({ type: 'inspect', id: x.id });
    }
  }

  // ------------------------------------------------------------------ side panes
  document.addEventListener('click', (e) => {
    const a = e.target.closest('[data-loc],[data-open],[data-sym],[data-mod],[data-act]');
    if (!a) return;
    if (a.dataset.ext) return;
    e.preventDefault();
    if (a.dataset.loc) {
      const m = /^(.*?):(\d+)$/.exec(a.dataset.loc);
      vscode.postMessage({ type: 'open', file: m ? m[1] : a.dataset.loc, line: m ? +m[2] : 1 });
    } else if (a.dataset.open) vscode.postMessage({ type: 'open', file: a.dataset.open, line: +(a.dataset.line || 1) });
    else if (a.dataset.sym) {
      if (st.nodeById.has(a.dataset.sym)) revealSymbol(a.dataset.sym, true);
      else vscode.postMessage({ type: 'inspect', id: a.dataset.sym });
    } else if (a.dataset.mod) {
      selectNode('m:' + a.dataset.mod, true);
      vscode.postMessage({ type: 'inspect', moduleId: a.dataset.mod });
    } else if (a.dataset.act) actions[a.dataset.act]?.(a.dataset.id, a);
  });

  const actions = {
    open: (id, a) => vscode.postMessage({ type: 'open', file: a.dataset.file, line: +a.dataset.line }),
    explain: (id) => vscode.postMessage({ type: 'explain', id }),
    explainModule: (id) => vscode.postMessage({ type: 'explain', moduleId: id }),
    impact: (id) => vscode.postMessage({ type: 'impact', id }),
    callers: (id) => vscode.postMessage({ type: 'callTree', id, direction: 'callers' }),
    callees: (id) => vscode.postMessage({ type: 'callTree', id, direction: 'callees' }),
    refs: (id) => vscode.postMessage({ type: 'findRefs', id }),
    focus: (id) => {
      revealSymbol(id, false);
      setFocus(id);
    },
    expandModule: (id) => {
      st.expanded.add(id);
      persist();
      render(true);
      selectNode('m:' + id, true);
    },
    members: (id) => {
      revealSymbol(id, false);
      toggleMembers(id);
    },
    showFlow: () => st.lastFlow && applyHighlightSet(st.lastFlow, true),
    showImpact: () => st.lastImpact && applyHighlightSet(st.lastImpact, true),
    cancelAI: () => vscode.postMessage({ type: 'cancelAI' }),
    askChat: () => vscode.postMessage({ type: 'chat' }),
  };

  const badge = (layer) => (layer ? `<span class="layer-badge" style="background:${colorOfLayer(layer)}">${h(layer)}</span>` : '');
  const symLink = (x, extra) => `<li><a data-sym="${h(x.id)}">${h(x.name)}</a> ${badge(x.layer)}${extra ? `<span class="t">${extra}</span>` : ''}</li>`;

  function renderInspector(d) {
    let html = '';
    if (d.kind === 'module') {
      html += `<h2>${h(d.name)}</h2><div class="sub">module · <code>${h(d.path)}</code> ${badge(d.layer)}</div>`;
      html += `<div class="actions"><button data-act="expandModule" data-id="${h(d.id)}">Show classes</button><button class="primary" data-act="explainModule" data-id="${h(d.id)}">Explain module (AI)</button></div>`;
      html += `<div class="metrics"><div class="metric"><b>${d.files.length}</b><span>files</span></div><div class="metric"><b>${d.symbols.length}</b><span>symbols</span></div><div class="metric"><b>${d.dependsOn.length}/${d.usedBy.length}</b><span>deps / users</span></div></div>`;
      html += `<h3>Depends on</h3><ul class="list">${d.dependsOn.map((x) => `<li><a data-mod="${h(x.id)}">${h(x.name)}</a><span class="t">${x.w} edges</span></li>`).join('') || '<li class="sub">nothing</li>'}</ul>`;
      html += `<h3>Used by</h3><ul class="list">${d.usedBy.map((x) => `<li><a data-mod="${h(x.id)}">${h(x.name)}</a><span class="t">${x.w} edges</span></li>`).join('') || '<li class="sub">nothing</li>'}</ul>`;
      html += `<h3>Symbols (by dependents)</h3><ul class="list">${d.symbols.slice(0, 80).map((x) => symLink(x, `${x.kind} · ${x.users} users`)).join('')}</ul>`;
      if (d.findings.length) html += `<h3>Findings</h3>${d.findings.map(findingHtml).join('')}`;
      html += `<h3>Files</h3><ul class="list">${d.files.slice(0, 200).map((f) => `<li><a data-open="${h(f)}">${h(f.split('/').pop())}</a><span class="t">${h(f.split('/').slice(-2, -1)[0] || '')}</span></li>`).join('')}</ul>`;
    } else {
      html += `<h2>${h(d.name)}</h2><div class="sub">${h(d.typeLabel)} · ${h(d.language)} ${badge(d.layer)}</div>`;
      html += `<div class="sub"><a data-open="${h(d.file)}" data-line="${d.line}">${h(d.file)}:${d.line}</a>${d.module ? ` · module <a data-mod="${h(d.module.id)}">${h(d.module.name)}</a>` : ''}</div>`;
      if (d.baseTypes?.length) html += `<div class="sub">extends/implements: ${d.baseTypes.map(h).join(', ')}</div>`;
      if (d.attributes?.length) html += `<div class="sub">attributes: ${d.attributes.map(h).join(', ')}</div>`;
      html += `<div class="actions">
        <button data-act="open" data-file="${h(d.file)}" data-line="${d.line}">Open</button>
        <button class="primary" data-act="explain" data-id="${h(d.focusMember || d.id)}">Explain (AI)</button>
        <button data-act="impact" data-id="${h(d.id)}">What could break?</button>
        <button data-act="callers" data-id="${h(d.focusMember || d.id)}">Callers</button>
        <button data-act="callees" data-id="${h(d.focusMember || d.id)}">Callees</button>
        <button data-act="refs" data-id="${h(d.focusMember || d.id)}">References</button>
        <button data-act="focus" data-id="${h(d.id)}">Focus</button>
        <button data-act="members" data-id="${h(d.id)}">Methods in graph</button></div>`;
      html += `<div class="metrics">
        <div class="metric"><b>${d.metrics.deps}</b><span>dependencies</span></div>
        <div class="metric"><b>${d.metrics.users}</b><span>used by</span></div>
        <div class="metric"><b>${d.metrics.methods}</b><span>methods</span></div>
        <div class="metric"><b>${d.metrics.lines}</b><span>lines</span></div>
        <div class="metric"><b>${d.metrics.callsIn}</b><span>calls in</span></div>
        <div class="metric"><b>${d.metrics.callsOut}</b><span>calls out</span></div></div>`;
      html += `<h3>Change risk</h3><span class="risk ${d.risk.level}">${d.risk.level}</span> <span class="sub">${d.risk.reasons.map(h).join(' · ')}</span>`;
      html += `<h3>Dependencies →</h3><ul class="list">${d.deps.map((x) => symLink(x, x.types.join(', '))).join('') || '<li class="sub">none</li>'}</ul>`;
      html += `<h3>Used by ←</h3><ul class="list">${d.users.map((x) => symLink(x, x.types.join(', '))).join('') || '<li class="sub">none found</li>'}</ul>`;
      const di = d.di;
      if (di.registrations.length || di.injections.length || di.injectedInto.length) {
        html += '<h3>Dependency injection</h3><ul class="list">';
        for (const r of di.registrations) html += `<li>registered as <b>${h(r.service)}</b> → ${h(r.impl)}<span class="t"><a data-open="${h(r.file)}" data-line="${r.line}">${h(r.scope || r.container)}${r.lifetime ? ' · ' + h(r.lifetime) : ''}</a></span></li>`;
        for (const i of di.injections) html += `<li>receives <b>${h(i.type)}</b> (${h(i.via)})<span class="t">${i.providers.length ? i.providers.map((p) => `<a data-open="${h(p.file)}" data-line="${p.line}">← ${h(p.impl)} @ ${h(p.scope)}</a>`).join(', ') : 'no registration found'}</span></li>`;
        for (const c of di.injectedInto) html += `<li>injected into <a data-sym="${h(c.id)}">${h(c.name)}</a><span class="t">${h(c.via)}</span></li>`;
        html += '</ul>';
      }
      if (d.findings.length) html += `<h3>Findings</h3>${d.findings.map(findingHtml).join('')}`;
      html += `<h3>Members</h3><ul class="list">${d.members
        .map((m) => `<li${m.id === d.focusMember ? ' style="font-weight:600"' : ''}><a data-open="${h(d.file)}" data-line="${m.line}">${h(m.name)}${m.params ? '(' + h(m.params.join(', ')) + ')' : ''}</a> <span class="sub">${h(m.kind)}${m.ret ? ': ' + h(m.ret) : ''}</span><span class="t">${m.callers ? `<a data-act="callers" data-id="${h(m.id)}">${m.callers} in</a>` : ''} ${m.callees ? `<a data-act="callees" data-id="${h(m.id)}">${m.callees} out</a>` : ''}</span></li>`)
        .join('')}</ul>`;
    }
    $('pane-inspector').innerHTML = html;
    $('pane-inspector').scrollTop = 0;
    showTab('inspector');
  }
  const findingHtml = (f) => `<div class="finding ${h(f.severity)}"><div>${f.file ? `<a data-open="${h(f.file)}" data-line="${f.line}">${h(f.title)}</a>` : h(f.title)}</div><div class="d">${h(f.detail)}</div></div>`;

  function renderImpact(d) {
    st.lastImpact = d.highlight;
    let html = `<h2>What could break?</h2><div class="sub">Changing ${d.targets.map((t) => `<a data-sym="${h(t.id)}">${h(t.name)}</a>`).join(', ')}</div>`;
    html += `<h3>Risk</h3><span class="risk ${d.risk}">${d.risk}</span> <span class="sub">score ${d.score}</span><ul>${d.reasons.map((r) => `<li>${h(r)}</li>`).join('')}</ul>`;
    html += `<div class="actions"><button data-act="showImpact">Highlight in graph</button></div>`;
    html += `<h3>Direct dependents (${d.direct.length})</h3><ul class="list">${d.direct.map((x) => symLink(x, x.via.join(', '))).join('') || '<li class="sub">none</li>'}</ul>`;
    html += `<h3>Indirect dependents (${d.indirect.length})</h3><ul class="list">${d.indirect.slice(0, 100).map((x) => symLink(x, `${x.distance} hops`)).join('') || '<li class="sub">none</li>'}</ul>`;
    html += `<h3>Modules / features affected</h3><ul class="list">${d.modules.map((m) => `<li>✓ <a data-mod="${h(m.id)}">${h(m.name)}</a><span class="t">${m.count}</span></li>`).join('')}</ul>`;
    html += '<div class="sub" style="margin-top:12px">An AI explanation is being written in the AI tab.</div>';
    $('pane-analysis').innerHTML = html;
    showTab('analysis');
  }

  function renderCallTree(dir, d) {
    if (!d) return;
    const node = (n) => `<li><a data-loc="${h(n.defFile)}:${n.defLine}">${h(n.name)}</a> <a class="lc" data-loc="${h(n.file)}:${n.line}">${h((n.file || '').split('/').pop())}:${n.line}</a>${n.confidence !== undefined && n.confidence < 0.7 ? ' <span class="lc">(uncertain)</span>' : ''}${n.truncated ? ' <span class="lc">…</span>' : ''}${n.children.length ? `<ul class="tree">${n.children.map(node).join('')}</ul>` : ''}</li>`;
    $('pane-analysis').innerHTML = `<h2>${dir === 'callers' ? 'Callers of' : 'Call flow from'} ${h(d.name)}</h2><div class="sub">${dir === 'callers' ? 'Who calls this (up to 5 levels)' : 'What this calls (up to 5 levels)'}</div>
      ${d.children.length ? `<ul class="tree" style="padding-left:0">${node(d)}</ul>` : `<div class="empty">No ${dir} found in analyzed code.</div>`}`;
    showTab('analysis');
  }

  function renderFlow(d) {
    st.lastFlow = d.steps.flatMap((s) => s.symbols.map((x) => x.id));
    let html = `<h2>Feature flow</h2><div class="sub">“${h(d.query)}”</div>`;
    if (!d.steps.length) {
      html += '<div class="empty">No symbols matched this feature. Try different words (class names, domain terms).</div>';
    } else {
      html += `<div class="actions"><button data-act="showFlow">Show in graph</button><button data-act="askChat">Ask a follow-up</button></div>`;
      html += '<div class="flow">';
      d.steps.forEach((s, i) => {
        if (i) html += '<div class="arrow">↓</div>';
        html += `<div class="step" style="border-left:4px solid ${colorOfLayer(s.layer)}"><div class="l" style="color:${colorOfLayer(s.layer)}">${h(s.layer)}</div>${s.symbols.map((x) => `<a data-sym="${h(x.id)}">${h(x.name)}</a>`).join(' · ')}</div>`;
      });
      html += '</div>';
      if (d.edges.length) html += `<h3>Connections</h3><ul class="list">${d.edges.slice(0, 40).map((e) => `<li>${h(nameOf(e.s))} → ${h(nameOf(e.t))}<span class="t">${e.file ? `<a data-loc="${h(e.file)}:${e.line}">${h(e.type)}</a>` : h(e.type)}</span></li>`).join('')}</ul>`;
      html += `<h3>Files involved</h3><ul class="list">${d.files.map((f) => `<li><a data-open="${h(f)}">${h(f.split('/').pop())}</a><span class="t">${h(f)}</span></li>`).join('')}</ul>`;
    }
    $('pane-analysis').innerHTML = html;
    showTab('analysis');
  }
  const nameOf = (id) => st.nodeById.get(id)?.name || id.split('#').pop();

  // AI pane (streaming markdown)
  let aiText = '';
  let aiPending = false;
  function renderAI(final) {
    aiPending = false;
    const body = $('ai-body');
    if (!body) return;
    body.innerHTML = renderMarkdown(aiText);
    body.classList.toggle('cursor', !final);
  }

  // ------------------------------------------------------------------ messages
  window.addEventListener('message', (ev) => {
    const m = ev.data;
    switch (m.type) {
      case 'graph': {
        const first = !st.data;
        st.data = m.data;
        st.nodeById = new Map(m.data.nodes.map((n) => [n.id, n]));
        st.moduleById = new Map(m.data.modules.map((x) => [x.id, x]));
        for (const id of [...st.expanded]) if (!st.moduleById.has(id)) st.expanded.delete(id);
        st.members.clear();
        st.expandedTypes.clear();
        $('title').textContent = m.data.project;
        $('patterns').textContent = m.data.patterns.map((p) => `${p.name} ${Math.round(p.confidence * 100)}%`).join(' · ');
        renderFilters();
        renderLegend();
        render(true);
        if (first && !m.data.modules.length) $('pane-inspector').innerHTML = '<div class="empty">No source files were analyzed.</div>';
        break;
      }
      case 'members':
        st.members.set(m.typeId, { members: m.members, edges: m.edges });
        st.expandedTypes.add(m.typeId);
        render(false);
        break;
      case 'inspector':
        renderInspector(m.data);
        if (m.data.kind === 'symbol' && st.nodeById.has(m.data.id) && cy.getElementById(m.data.id).nonempty()) selectNode(m.data.id, false);
        break;
      case 'reveal':
        revealSymbol(m.id, false);
        break;
      case 'impact':
        renderImpact(m.data);
        applyHighlightSet(m.data.highlight, true);
        break;
      case 'callTree':
        renderCallTree(m.direction, m.data);
        break;
      case 'flow':
        renderFlow(m.data);
        if (st.lastFlow.length) applyHighlightSet(st.lastFlow, true);
        break;
      case 'highlightPath':
        if (!m.found) toast('No dependency path found between these nodes');
        else {
          st.highlight = m.ids;
          applyHighlightSet(m.ids, true);
          toast('Path: ' + m.ids.map(nameOf).join(' → '));
        }
        break;
      case 'searchResults':
        hits = m.hits;
        hitSel = hits.length ? 0 : -1;
        renderHits();
        break;
      case 'ai':
        if (m.reset) {
          aiText = '';
          $('pane-ai').innerHTML = `<h2>${h(m.title)}</h2><div class="sub">${h(m.provider)} · grounded in static analysis · <a data-act="cancelAI">stop</a></div><div class="ai-body cursor" id="ai-body"></div>`;
          showTab('ai');
        } else if (m.chunk) {
          aiText += m.chunk;
          if (!aiPending) {
            aiPending = true;
            requestAnimationFrame(() => renderAI(false));
          }
        } else if (m.done) {
          renderAI(true);
        } else if (m.error) {
          renderAI(true);
          $('pane-ai').insertAdjacentHTML('beforeend', `<div class="finding error"><div>AI request failed</div><div class="d">${h(m.error)}</div></div>`);
        }
        if (!document.querySelector('#tabs button[data-tab="ai"]').classList.contains('on')) markTab('ai');
        break;
    }
  });

  function toast(msg) {
    const t = document.createElement('div');
    t.className = 'toast';
    t.textContent = msg;
    $('cy').appendChild(t);
    setTimeout(() => t.remove(), 3500);
  }

  window.addEventListener('resize', () => cy.resize());
  vscode.postMessage({ type: 'ready' });
})();
