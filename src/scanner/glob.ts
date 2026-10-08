// Minimal glob matcher for exclude patterns (supports **, *, ?, and {a,b}).

export function globToRegExp(glob: string): RegExp {
  let re = '';
  let i = 0;
  while (i < glob.length) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        // "**/" matches zero or more directories
        if (glob[i + 2] === '/') {
          re += '(?:.*/)?';
          i += 3;
        } else {
          re += '.*';
          i += 2;
        }
      } else {
        re += '[^/]*';
        i++;
      }
    } else if (c === '?') {
      re += '[^/]';
      i++;
    } else if (c === '{') {
      const end = glob.indexOf('}', i);
      if (end < 0) {
        re += '\\{';
        i++;
      } else {
        re += '(?:' + glob.slice(i + 1, end).split(',').map(escape).join('|') + ')';
        i = end + 1;
      }
    } else {
      re += escape(c);
      i++;
    }
  }
  return new RegExp('^' + re + '$', 'i');
}

function escape(s: string): string {
  return s.replace(/[.+^${}()|[\]\\]/g, '\\$&');
}

export class GlobSet {
  private readonly regexes: RegExp[];
  constructor(patterns: string[]) {
    this.regexes = patterns.map(globToRegExp);
  }
  matches(relPath: string): boolean {
    return this.regexes.some((r) => r.test(relPath));
  }
  /** True when a directory (and therefore everything below it) is excluded. */
  matchesDir(relDir: string): boolean {
    const probe = relDir.endsWith('/') ? relDir + '__probe__' : relDir + '/__probe__';
    return this.regexes.some((r) => r.test(probe) && r.source.includes('.*'));
  }
}

/** Converts simple .gitignore lines into glob patterns (negations are ignored). */
export function gitignoreToGlobs(content: string): string[] {
  const out: string[] = [];
  for (let line of content.split(/\r?\n/)) {
    line = line.trim();
    if (!line || line.startsWith('#') || line.startsWith('!')) continue;
    const anchored = line.startsWith('/');
    if (anchored) line = line.slice(1);
    const dirOnly = line.endsWith('/');
    if (dirOnly) line = line.slice(0, -1);
    if (!line) continue;
    const base = anchored || line.includes('/') ? line : '**/' + line;
    out.push(base + '/**');
    if (!dirOnly) out.push(base);
  }
  return out;
}
