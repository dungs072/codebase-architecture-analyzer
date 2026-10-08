// Minimal, safe markdown renderer for AI output. HTML in the source is escaped first.
// Links whose target is not http(s) are treated as code citations ("path:line") and get data-loc.
(function () {
  function esc(s) {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function inline(s) {
    // s is already escaped
    const codes = [];
    s = s.replace(/`([^`]+)`/g, (_, c) => {
      codes.push(c);
      return '\u0000' + (codes.length - 1) + '\u0000';
    });
    s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, text, href) => {
      if (/^https?:/i.test(href)) return `<a href="${href}" data-ext="1">${text}</a>`;
      const loc = href.replace(/#L(\d+).*$/, ':$1');
      return `<a href="#" class="cite" data-loc="${loc}" title="${loc}">${text}</a>`;
    });
    s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    s = s.replace(/(^|[^\w*])\*([^*\n]+)\*(?!\w)/g, '$1<em>$2</em>');
    s = s.replace(/(^|[^\w])_([^_\n]+)_(?!\w)/g, '$1<em>$2</em>');
    // bare path:line citations, e.g. Assets/Game/Foo.cs:12
    s = s.replace(/(^|[\s(])((?:[\w.-]+\/)+[\w.-]+\.(?:cs|ts|tsx|js|jsx|mts|cts)):(\d+)/g, (_, pre, p, l) => `${pre}<a href="#" class="cite" data-loc="${p}:${l}">${p}:${l}</a>`);
    s = s.replace(/\u0000(\d+)\u0000/g, (_, i) => {
      const c = codes[+i];
      const m = /^((?:[\w.-]+\/)+[\w.-]+\.(?:cs|ts|tsx|js|jsx)):(\d+)$/.exec(c);
      return m ? `<a href="#" class="cite" data-loc="${c}"><code>${c}</code></a>` : `<code>${c}</code>`;
    });
    return s;
  }

  function render(md) {
    const lines = esc(md || '').split(/\r?\n/);
    const out = [];
    let i = 0;
    let list = null; // 'ul' | 'ol'
    const closeList = () => {
      if (list) out.push(`</${list}>`);
      list = null;
    };
    while (i < lines.length) {
      const line = lines[i];
      const fence = /^\s*```(\w*)/.exec(line);
      if (fence) {
        closeList();
        const buf = [];
        i++;
        while (i < lines.length && !/^\s*```/.test(lines[i])) buf.push(lines[i++]);
        i++;
        out.push(`<pre><code class="lang-${fence[1]}">${buf.join('\n')}</code></pre>`);
        continue;
      }
      const h = /^(#{1,4})\s+(.*)$/.exec(line);
      if (h) {
        closeList();
        out.push(`<h${h[1].length + 1}>${inline(h[2])}</h${h[1].length + 1}>`);
        i++;
        continue;
      }
      if (/^\s*\|.*\|\s*$/.test(line) && i + 1 < lines.length && /^\s*\|?[\s:-]+\|[\s|:-]*$/.test(lines[i + 1])) {
        closeList();
        const row = (l) => l.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
        const head = row(line);
        i += 2;
        const body = [];
        while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) body.push(row(lines[i++]));
        out.push(`<table><thead><tr>${head.map((c) => `<th>${inline(c)}</th>`).join('')}</tr></thead><tbody>${body.map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join('')}</tr>`).join('')}</tbody></table>`);
        continue;
      }
      const ul = /^(\s*)[-*•]\s+(.*)$/.exec(line);
      const ol = /^(\s*)\d+[.)]\s+(.*)$/.exec(line);
      if (ul || ol) {
        const kind = ul ? 'ul' : 'ol';
        if (list !== kind) {
          closeList();
          out.push(`<${kind}>`);
          list = kind;
        }
        const indent = (ul || ol)[1].length;
        out.push(`<li${indent >= 2 ? ' class="nested"' : ''}>${inline((ul || ol)[2])}</li>`);
        i++;
        continue;
      }
      if (/^&gt;\s?/.test(line)) {
        closeList();
        out.push(`<blockquote>${inline(line.replace(/^&gt;\s?/, ''))}</blockquote>`);
        i++;
        continue;
      }
      if (/^\s*(---|\*\*\*)\s*$/.test(line)) {
        closeList();
        out.push('<hr>');
        i++;
        continue;
      }
      if (!line.trim()) {
        closeList();
        i++;
        continue;
      }
      closeList();
      const para = [line];
      i++;
      while (i < lines.length && lines[i].trim() && !/^(#{1,4}\s|\s*```|\s*[-*•]\s|\s*\d+[.)]\s|&gt;|\s*\|)/.test(lines[i])) para.push(lines[i++]);
      out.push(`<p>${inline(para.join(' '))}</p>`);
    }
    closeList();
    return out.join('\n');
  }

  window.renderMarkdown = render;
  window.escapeHtml = esc;
})();
