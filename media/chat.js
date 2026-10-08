/* global acquireVsCodeApi, renderMarkdown, escapeHtml */
(function () {
  const vscode = acquireVsCodeApi();
  const app = document.getElementById('app');
  app.innerHTML = `
    <div class="chat-head"><div><b id="proj">Codebase Chat</b><span class="sub" id="prov"></span></div><div><button id="stop" class="small hidden">Stop</button> <button id="clear" class="small">New chat</button></div></div>
    <div id="log"></div>
    <div class="composer"><textarea id="input" rows="1" placeholder="Ask about the architecture… (Enter to send, Shift+Enter for newline)"></textarea><button id="send" class="primary">Send</button></div>`;
  const log = document.getElementById('log');
  const input = document.getElementById('input');
  const SUGGESTIONS = [
    'How does the save system work?',
    'Where is player money modified?',
    'What happens when the player clicks a button on the main screen?',
    'Where should I add a new feature like a new crop or item?',
    'If I remove the most-used manager, what breaks?',
    'Which classes depend on UI but should not?',
    'How does dependency injection connect the project?',
    'What conventions does this project follow?',
  ];

  function welcome(project) {
    log.innerHTML = `<div class="welcome"><h2>Ask about ${escapeHtml(project || 'this codebase')}</h2>
      <p>Answers are built from the static-analysis graph: for each question the tool retrieves the relevant symbols, their dependencies and callers, and source snippets — only those are sent to the model. Citations open the exact file and line.</p>
      <div class="suggest">${SUGGESTIONS.map((s) => `<span class="chip" data-q="${escapeHtml(s)}">${escapeHtml(s)}</span>`).join('')}</div></div>`;
  }

  let current = null;
  let text = '';
  let pending = false;
  const flush = (final) => {
    pending = false;
    if (!current) return;
    current.innerHTML = renderMarkdown(text);
    current.classList.toggle('cursor', !final);
    log.scrollTop = log.scrollHeight;
  };

  function send(q) {
    q = (q ?? input.value).trim();
    if (!q) return;
    input.value = '';
    autosize();
    vscode.postMessage({ type: 'ask', text: q });
  }

  function autosize() {
    input.style.height = 'auto';
    input.style.height = Math.min(160, input.scrollHeight) + 'px';
  }

  input.addEventListener('input', autosize);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  });
  document.getElementById('send').addEventListener('click', () => send());
  document.getElementById('stop').addEventListener('click', () => vscode.postMessage({ type: 'stop' }));
  document.getElementById('clear').addEventListener('click', () => {
    vscode.postMessage({ type: 'clear' });
    welcome(document.getElementById('proj').dataset.project);
  });
  document.addEventListener('click', (e) => {
    const chip = e.target.closest('[data-q]');
    if (chip) return send(chip.dataset.q);
    const a = e.target.closest('[data-loc]');
    if (a) {
      e.preventDefault();
      const m = /^(.*?):(\d+)$/.exec(a.dataset.loc);
      vscode.postMessage({ type: 'open', file: m ? m[1] : a.dataset.loc, line: m ? +m[2] : 1 });
    }
  });

  window.addEventListener('message', (ev) => {
    const m = ev.data;
    const stop = document.getElementById('stop');
    switch (m.type) {
      case 'init':
        document.getElementById('proj').textContent = 'Codebase Chat — ' + m.project;
        document.getElementById('proj').dataset.project = m.project;
        document.getElementById('prov').textContent = '· ' + m.provider;
        welcome(m.project);
        break;
      case 'user': {
        log.querySelector('.welcome')?.remove();
        const d = document.createElement('div');
        d.className = 'msg user';
        d.textContent = m.text;
        log.appendChild(d);
        log.scrollTop = log.scrollHeight;
        break;
      }
      case 'start':
        text = '';
        current = document.createElement('div');
        current.className = 'msg assistant cursor';
        log.appendChild(current);
        stop.classList.remove('hidden');
        break;
      case 'chunk':
        text += m.text;
        if (!pending) {
          pending = true;
          requestAnimationFrame(() => flush(false));
        }
        break;
      case 'done':
        flush(true);
        current = null;
        stop.classList.add('hidden');
        break;
      case 'error': {
        if (current) flush(true);
        current = null;
        stop.classList.add('hidden');
        const d = document.createElement('div');
        d.className = 'msg error';
        d.textContent = m.text;
        log.appendChild(d);
        break;
      }
    }
  });
  vscode.postMessage({ type: 'ready' });
  input.focus();
})();
