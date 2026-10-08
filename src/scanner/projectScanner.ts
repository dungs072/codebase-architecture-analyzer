import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { FileInfo, FileType, Language, ProjectInfo } from '../model/types';
import { GlobSet, gitignoreToGlobs } from './glob';

export interface ScanOptions {
  exclude: string[];
  maxFiles: number;
}

export interface ScanResult {
  project: ProjectInfo;
  files: FileInfo[];
  /** Absolute paths of source files the parsers should process. */
  sourceFiles: { rel: string; abs: string; language: Language; hash: string }[];
}

const SOURCE_EXT: Record<string, Language> = {
  '.cs': 'csharp',
  '.ts': 'typescript',
  '.tsx': 'typescript',
  '.mts': 'typescript',
  '.cts': 'typescript',
  '.js': 'javascript',
  '.jsx': 'javascript',
  '.mjs': 'javascript',
};

const CONFIG_NAMES = new Set([
  '.gitignore', 'package.json', 'tsconfig.json', 'jsconfig.json', 'manifest.json', 'packages-lock.json',
  'project.json', 'creator.d.ts', 'settings.json', 'nuget.config', 'directory.build.props', 'global.json',
  '.editorconfig', 'angular.json', 'vite.config.ts', 'webpack.config.js',
]);

const MAX_SOURCE_BYTES = 1_500_000;

export function hashContent(buf: Buffer | string): string {
  return crypto.createHash('sha1').update(buf).digest('hex').slice(0, 16);
}

export function scanProject(root: string, opts: ScanOptions): ScanResult {
  const excludes = [...opts.exclude];
  const gitignorePath = path.join(root, '.gitignore');
  if (fs.existsSync(gitignorePath)) {
    excludes.push(...gitignoreToGlobs(fs.readFileSync(gitignorePath, 'utf8')));
  }
  const exclude = new GlobSet(excludes);

  const files: FileInfo[] = [];
  const sourceFiles: ScanResult['sourceFiles'] = [];
  const languages: Record<string, number> = {};
  const fileTypes: Record<string, number> = {};
  const configFiles: string[] = [];
  const topDirs = new Map<string, { source: number; test: number }>();

  const stack: string[] = [''];
  while (stack.length && files.length < opts.maxFiles) {
    const relDir = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(path.join(root, relDir), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const rel = relDir ? `${relDir}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (e.name === '.git' || exclude.matchesDir(rel) || exclude.matches(rel)) continue;
        stack.push(rel);
        continue;
      }
      if (!e.isFile() || exclude.matches(rel)) continue;
      if (e.name.endsWith('.meta')) continue; // Unity metadata, never interesting

      const abs = path.join(root, rel);
      let size = 0;
      try {
        size = fs.statSync(abs).size;
      } catch {
        continue;
      }
      const ext = path.extname(e.name).toLowerCase();
      const language: Language = SOURCE_EXT[ext] ?? (ext === '.json' ? 'json' : 'other');
      const type = classifyFile(rel, e.name, ext);
      let hash = '';
      if ((type === 'source' || type === 'test') && language !== 'other' && size <= MAX_SOURCE_BYTES) {
        const buf = fs.readFileSync(abs);
        hash = hashContent(buf);
        if (looksGenerated(rel, buf)) {
          files.push({ path: rel, language, type: 'generated', size, hash });
          fileTypes.generated = (fileTypes.generated ?? 0) + 1;
          continue;
        }
        sourceFiles.push({ rel, abs, language, hash });
        languages[language] = (languages[language] ?? 0) + 1;
        const top = rel.split('/').slice(0, rel.startsWith('Assets/') ? 2 : 1).join('/');
        const t = topDirs.get(top) ?? { source: 0, test: 0 };
        if (type === 'test') t.test++;
        else t.source++;
        topDirs.set(top, t);
      }
      if (type === 'configuration' || type === 'dependency-config') configFiles.push(rel);
      fileTypes[type] = (fileTypes[type] ?? 0) + 1;
      files.push({ path: rel, language, type, size, hash, role: fileRole(e.name, type) });
    }
  }

  const project: ProjectInfo = {
    root,
    name: path.basename(root),
    languages,
    frameworks: detectFrameworks(root, files),
    packageManagers: detectPackageManagers(root),
    sourceFolders: [...topDirs].filter(([, v]) => v.source > 0).map(([k]) => k).sort(),
    testFolders: [...topDirs].filter(([, v]) => v.test > 0).map(([k]) => k).sort(),
    configFiles: configFiles.sort(),
    fileTypes,
  };
  return { project, files, sourceFiles };
}

function classifyFile(rel: string, name: string, ext: string): FileType {
  const lower = name.toLowerCase();
  if (SOURCE_EXT[ext]) {
    if (/(^|\/)(tests?|specs?|__tests__|editor\/tests?)(\/|$)/i.test(rel) || /\.(test|spec)\.[jt]sx?$/.test(lower) || /tests?\.cs$/i.test(name)) {
      return 'test';
    }
    if (/\.(g|designer|generated)\.cs$/i.test(name)) return 'generated';
    return 'source';
  }
  if (ext === '.unity') return 'unity-scene';
  if (ext === '.prefab') return 'unity-prefab';
  if (['.asset', '.mat', '.anim', '.controller', '.physicmaterial', '.scene', '.fire'].includes(ext)) return 'unity-asset';
  if (lower === 'package.json' || lower === 'manifest.json' || lower === 'packages-lock.json' || ext === '.csproj' || ext === '.sln' || lower.endsWith('.asmdef')) {
    return 'dependency-config';
  }
  if (CONFIG_NAMES.has(lower) || ['.json', '.yaml', '.yml', '.xml', '.config', '.props', '.ini', '.toml'].includes(ext)) {
    return 'configuration';
  }
  return 'other';
}

function looksGenerated(rel: string, buf: Buffer): boolean {
  if (/(^|\/)(generated|gen|autogen)(\/|$)/i.test(rel)) return true;
  const head = buf.subarray(0, 600).toString('utf8');
  return /<auto-generated|@generated|This file is (auto-?)?generated/i.test(head);
}

function fileRole(name: string, type: FileType): string | undefined {
  if (type !== 'source') return type;
  const base = name.replace(/\.[^.]+$/, '');
  for (const [re, role] of ROLE_SUFFIXES) if (re.test(base)) return role;
  return 'class';
}

const ROLE_SUFFIXES: [RegExp, string][] = [
  [/(View|Screen|Panel|Window|Popup|Dialog|Widget|Page|Component|Hud|UI)$/i, 'UI'],
  [/(Presenter|ViewModel|Controller)$/i, 'controller'],
  [/(Config|Settings|Options|Constants)$/i, 'configuration'],
  [/(Data|Model|Dto|Entity|State|Record)$/i, 'data'],
];

function detectFrameworks(root: string, files: FileInfo[]): string[] {
  const out = new Set<string>();
  const has = (p: string) => fs.existsSync(path.join(root, p));
  if (has('ProjectSettings') && has('Assets')) out.add('Unity');
  const unityManifest = path.join(root, 'Packages/manifest.json');
  if (fs.existsSync(unityManifest)) {
    const text = safeRead(unityManifest);
    const pkgs: [string, string][] = [
      ['jp.hadashikick.vcontainer', 'VContainer'],
      ['com.cysharp.r3', 'R3'],
      ['com.neuecc.unirx', 'UniRx'],
      ['com.cysharp.unitask', 'UniTask'],
      ['com.demigiant.dotween', 'DOTween'],
      ['com.svermeulen.extenject', 'Zenject'],
      ['com.unity.entities', 'Unity ECS (DOTS)'],
      ['com.unity.addressables', 'Addressables'],
      ['com.unity.inputsystem', 'Input System'],
      ['com.unity.netcode', 'Netcode'],
      ['com.cysharp.messagepipe', 'MessagePipe'],
    ];
    for (const [id, name] of pkgs) if (text.includes(id)) out.add(name);
  }
  // Plugins dropped into Assets (common for DOTween / Zenject / VContainer source installs)
  for (const f of files) {
    if (/\/DOTween\//i.test(f.path)) out.add('DOTween');
    if (/\/(Zenject|Extenject)\//i.test(f.path)) out.add('Zenject');
    if (/\/VContainer\//i.test(f.path)) out.add('VContainer');
  }
  const pkgJsonPath = path.join(root, 'package.json');
  if (fs.existsSync(pkgJsonPath)) {
    try {
      const pkg = JSON.parse(safeRead(pkgJsonPath));
      const deps = { ...pkg.dependencies, ...pkg.devDependencies };
      const map: [string, string][] = [
        ['react', 'React'], ['vue', 'Vue'], ['@angular/core', 'Angular'], ['next', 'Next.js'], ['express', 'Express'],
        ['@nestjs/core', 'NestJS'], ['inversify', 'InversifyJS'], ['tsyringe', 'tsyringe'], ['rxjs', 'RxJS'],
        ['electron', 'Electron'], ['phaser', 'Phaser'], ['pixi.js', 'PixiJS'], ['@types/vscode', 'VS Code Extension'],
      ];
      for (const [id, name] of map) if (deps?.[id]) out.add(name);
      if (pkg.creator || pkg.engine === 'cocos-creator' || deps?.cc) out.add('Cocos Creator');
    } catch {
      /* ignore malformed package.json */
    }
  }
  if (has('project.json') && safeRead(path.join(root, 'project.json')).includes('cocos')) out.add('Cocos Creator');
  if (has('assets') && has('settings') && files.some((f) => f.path.endsWith('.fire') || f.path.endsWith('.scene'))) out.add('Cocos Creator');
  if (files.some((f) => f.path.endsWith('.csproj')) && !out.has('Unity')) out.add('.NET');
  return [...out].sort();
}

function detectPackageManagers(root: string): string[] {
  const pm: [string, string][] = [
    ['package-lock.json', 'npm'], ['yarn.lock', 'yarn'], ['pnpm-lock.yaml', 'pnpm'], ['bun.lockb', 'bun'],
    ['Packages/manifest.json', 'Unity Package Manager'], ['packages.config', 'NuGet'], ['Directory.Packages.props', 'NuGet'],
  ];
  return pm.filter(([f]) => fs.existsSync(path.join(root, f))).map(([, n]) => n);
}

function safeRead(p: string): string {
  try {
    return fs.readFileSync(p, 'utf8');
  } catch {
    return '';
  }
}
