import { DIInfo, LayerInfo, ModuleInfo, PatternFinding, Relationship, SymbolInfo, TYPE_KINDS } from '../model/types';
import { DEPENDENCY_TYPES } from './graph';

// ---------------------------------------------------------------------------
// Module detection (folder structure first, namespace as a tie-breaker)
// ---------------------------------------------------------------------------

const WRAPPER_DIRS = new Set(['assets', 'scripts', 'script', 'src', 'source', 'sources', 'lib', 'app', 'code', 'runtime', 'game', '_game', '_project', 'project', 'main', 'client']);

export function detectModules(symbols: SymbolInfo[], relationships: Relationship[], sourceFiles: string[]): ModuleInfo[] {
  const dirsOf = (f: string): string[] => f.split('/').slice(0, -1);
  const files = sourceFiles.filter((f) => !/(^|\/)(Plugins|ThirdParty|Third-Party|External|Vendor|node_modules)(\/|$)/i.test(f));
  const firstParty = new Set(files);
  const thirdParty = sourceFiles.filter((f) => !firstParty.has(f));

  // Strip a common prefix made only of wrapper folders (Assets/Scripts/..., src/...)
  let prefix: string[] = [];
  if (files.length) {
    prefix = dirsOf(files[0]);
    for (const f of files) {
      const d = dirsOf(f);
      let n = 0;
      while (n < prefix.length && n < d.length && prefix[n] === d[n]) n++;
      prefix = prefix.slice(0, n);
    }
  }
  // Also strip leading wrapper dirs even if not common to all files (e.g. Assets/Scripts vs Assets/Editor)
  const keyFor = (f: string, depth: number): string => {
    const d = dirsOf(f);
    let start = prefix.length;
    while (start < d.length - 0 && WRAPPER_DIRS.has(d[start]?.toLowerCase()) && start < d.length - 1) start++;
    const parts = d.slice(start, start + depth);
    return parts.length ? d.slice(0, start + depth).join('/') : d.join('/') || '(root)';
  };
  // Adaptive depth: go deeper while we only have one or two buckets holding most files.
  let depth = 1;
  for (; depth < 4; depth++) {
    const buckets = new Map<string, number>();
    for (const f of files) buckets.set(keyFor(f, depth), (buckets.get(keyFor(f, depth)) ?? 0) + 1);
    const sorted = [...buckets.values()].sort((a, b) => b - a);
    const dominant = sorted[0] ?? 0;
    if (buckets.size >= 4 || dominant < files.length * 0.6) break;
  }

  const moduleOfFile = new Map<string, string>();
  for (const f of files) moduleOfFile.set(f, keyFor(f, depth));

  // Split oversized modules (e.g. one "Gameplay" folder holding most of the code) into their subfolders.
  for (let iter = 0; iter < 3; iter++) {
    const groups = new Map<string, string[]>();
    for (const f of files) {
      const k = moduleOfFile.get(f)!;
      const g = groups.get(k);
      if (g) g.push(f);
      else groups.set(k, [f]);
    }
    let changed = false;
    for (const [key, fs] of groups) {
      if (key === '(root)' || fs.length < 30 || fs.length < files.length * 0.3) continue;
      const depthKey = key.split('/').length;
      const sub = new Map<string, string[]>();
      for (const f of fs) {
        const d = dirsOf(f);
        const k = d.length > depthKey ? d.slice(0, depthKey + 1).join('/') : key;
        const g = sub.get(k);
        if (g) g.push(f);
        else sub.set(k, [f]);
      }
      if (sub.size === 1 && sub.has(key)) continue; // all files directly in the folder
      for (const [k, sfs] of sub) for (const f of sfs) moduleOfFile.set(f, k);
      changed = true;
    }
    if (!changed) break;
  }
  for (const f of thirdParty) {
    const d = dirsOf(f);
    const i = d.findIndex((x) => /^(Plugins|ThirdParty|Third-Party|External|Vendor|node_modules)$/i.test(x));
    moduleOfFile.set(f, d.slice(0, i + 2).join('/'));
  }

  const modules = new Map<string, ModuleInfo>();
  for (const [f, key] of moduleOfFile) {
    let m = modules.get(key);
    if (!m) {
      const name = key === '(root)' ? '(root)' : key.split('/').pop()!;
      modules.set(key, (m = { id: key, name, path: key, files: [], symbols: [], dependsOn: {} }));
    }
    m.files.push(f);
  }
  // Disambiguate duplicate display names ("UI" in two places)
  const nameCount = new Map<string, number>();
  for (const m of modules.values()) nameCount.set(m.name, (nameCount.get(m.name) ?? 0) + 1);
  for (const m of modules.values()) if ((nameCount.get(m.name) ?? 0) > 1) m.name = m.path.split('/').slice(-2).join('/');

  const symMod = new Map<string, string>();
  for (const s of symbols) {
    const key = moduleOfFile.get(s.file);
    if (!key) continue;
    s.module = key;
    symMod.set(s.id, key);
    if (TYPE_KINDS.has(s.kind) || !s.parent) modules.get(key)!.symbols.push(s.id);
  }
  for (const r of relationships) {
    if (!DEPENDENCY_TYPES.has(r.type) && r.type !== 'calls') continue;
    const a = symMod.get(r.source);
    const b = symMod.get(r.target);
    if (!a || !b || a === b) continue;
    const m = modules.get(a)!;
    m.dependsOn[b] = (m.dependsOn[b] ?? 0) + 1;
  }
  return [...modules.values()].sort((a, b) => a.path.localeCompare(b.path));
}

// ---------------------------------------------------------------------------
// Layer inference
// ---------------------------------------------------------------------------

interface LayerRule {
  layer: string;
  rank: number;
  name?: RegExp;
  folder?: RegExp;
  base?: RegExp;
}

// Rank: lower = closer to the user. Names are what the project *actually* uses, not an imposed model.
const LAYER_RULES: LayerRule[] = [
  { layer: 'Composition', rank: 0, name: /(LifetimeScope|Installer|Bootstrap(per)?|Bootstrapper|EntryPoint|CompositionRoot|Startup|Program|Main)$/, base: /^(LifetimeScope|MonoInstaller|Installer|ScriptableObjectInstaller|IInstaller)$/ },
  { layer: 'UI', rank: 1, name: /(View|Screen|Panel|Window|Popup|Dialog|Widget|Page|Hud|HUD|UI|Button|Toggle|Slider|Menu|Tooltip|Canvas|Cell|Item(View|UI)|Renderer)$/, folder: /(^|\/)(UI|Views?|Screens?|Popups?|Windows?|Pages?|Components|Widgets?|Presentation)(\/|$)/i },
  { layer: 'Controller', rank: 2, name: /(Controller|Presenter|ViewModel|Mediator|Handler|Router|Coordinator|Binder)$/, folder: /(^|\/)(Controllers?|Presenters?|ViewModels?)(\/|$)/i },
  { layer: 'Gameplay', rank: 3, name: /(Manager|System|Director|Action|Command|State|StateMachine|Behaviour|Behavior|Spawner|Logic|Ability|Skill|UseCase|Interactor)$/, folder: /(^|\/)(Gameplay|Systems?|Actions?|Commands?|States?|Logic|UseCases?|Application|Features?)(\/|$)/i },
  { layer: 'Service', rank: 4, name: /(Service|Provider|Client|Api|API|Gateway|Facade|Loader|Tracker)$/, folder: /(^|\/)(Services?|Providers?|Api)(\/|$)/i },
  { layer: 'Data', rank: 5, name: /(Data|Model|Entity|Config|Configs|Settings|Dto|DTO|Definition|Def|Info|Record|Table|Database|Repository|Repo|Store|Storage|Dao|Save|SaveData|Profile|Constants)$/, folder: /(^|\/)(Data|Models?|Domain|Entities|Configs?|Settings|Repositories|Persistence|Storage|Save)(\/|$)/i, base: /^(ScriptableObject|IComponentData)$/ },
  { layer: 'Infrastructure', rank: 6, name: /(Util|Utils|Utility|Utilities|Helper|Helpers|Extensions?|Pool|Logger|Log|Factory|Singleton|Timer|Pool|Serializer|Converter|Wrapper|Adapter|Base|Core)$/, folder: /(^|\/)(Infrastructure|Utils?|Utilities|Helpers?|Extensions?|Core|Common|Shared|Framework|Plugins|Tools)(\/|$)/i },
];

export function inferLayers(symbols: SymbolInfo[], relationships: Relationship[]): LayerInfo[] {
  const counts = new Map<string, { rule: LayerRule; n: number; byName: number; byFolder: number; byBase: number; examples: string[] }>();
  const types = symbols.filter((s) => TYPE_KINDS.has(s.kind) || (!s.parent && s.kind === 'function' && s.exported));
  const byId = new Map(symbols.map((s) => [s.id, s]));
  for (const s of types) {
    const bare = s.kind === 'interface' && /^I[A-Z]/.test(s.name) ? s.name.slice(1) : s.name;
    let chosen: LayerRule | undefined;
    let why: 'byName' | 'byFolder' | 'byBase' = 'byName';
    for (const r of LAYER_RULES) if (r.base && s.baseTypes?.some((b) => r.base!.test(b))) {
      chosen = r;
      why = 'byBase';
      break;
    }
    if (!chosen) for (const r of LAYER_RULES) if (r.name?.test(bare)) {
      chosen = r;
      why = 'byName';
      break;
    }
    if (!chosen) for (const r of LAYER_RULES) if (r.folder?.test(s.file)) {
      chosen = r;
      why = 'byFolder';
      break;
    }
    // TSX components default to UI
    if (!chosen && s.file.endsWith('.tsx')) chosen = LAYER_RULES[1];
    if (!chosen) continue;
    s.layer = chosen.layer;
    let c = counts.get(chosen.layer);
    if (!c) counts.set(chosen.layer, (c = { rule: chosen, n: 0, byName: 0, byFolder: 0, byBase: 0, examples: [] }));
    c.n++;
    c[why]++;
    if (c.examples.length < 4) c.examples.push(s.name);
  }
  // members inherit their type's layer
  for (const s of symbols) if (!s.layer && s.parent) {
    let p = byId.get(s.parent);
    while (p && !p.layer && p.parent) p = byId.get(p.parent);
    if (p?.layer) s.layer = p.layer;
  }
  void relationships;
  return [...counts.entries()]
    .map(([name, c]) => ({
      name,
      rank: c.rule.rank,
      symbols: c.n,
      evidence: [
        c.byName ? `${c.byName} type${c.byName === 1 ? '' : 's'} by naming convention` : '',
        c.byFolder ? `${c.byFolder} by folder` : '',
        c.byBase ? `${c.byBase} by base type` : '',
        `e.g. ${c.examples.join(', ')}`,
      ].filter(Boolean),
    }))
    .sort((a, b) => a.rank - b.rank);
}

export function assignModuleLayers(modules: ModuleInfo[], symbols: SymbolInfo[]): void {
  const byId = new Map(symbols.map((s) => [s.id, s]));
  for (const m of modules) {
    const c = new Map<string, number>();
    for (const id of m.symbols) {
      const l = byId.get(id)?.layer;
      if (l) c.set(l, (c.get(l) ?? 0) + 1);
    }
    const best = [...c].sort((a, b) => b[1] - a[1])[0];
    if (/(^|\/)(Plugins|ThirdParty|Third-Party|Vendor|External|node_modules)(\/|$)/i.test(m.path)) m.layer = 'Third-party';
    else if (best && best[1] >= Math.max(1, m.symbols.length * 0.3)) m.layer = best[0];
    else m.layer = best ? 'Mixed' : undefined;
  }
}

export function layerRank(layer: string | undefined): number | undefined {
  return LAYER_RULES.find((r) => r.layer === layer)?.rank;
}

// ---------------------------------------------------------------------------
// Pattern detection
// ---------------------------------------------------------------------------

export function detectPatterns(symbols: SymbolInfo[], relationships: Relationship[], di: DIInfo, frameworks: string[], files: string[]): PatternFinding[] {
  const types = symbols.filter((s) => TYPE_KINDS.has(s.kind));
  const classes = types.filter((s) => s.kind === 'class' || s.kind === 'struct' || s.kind === 'record');
  const total = Math.max(1, classes.length);
  const named = (re: RegExp): SymbolInfo[] => classes.filter((s) => re.test(s.name));
  const byId = new Map(symbols.map((s) => [s.id, s]));
  const out: PatternFinding[] = [];
  const conf = (n: number, k: number): number => Math.min(0.97, 1 - Math.exp(-n / k));
  const ex = (arr: SymbolInfo[], n = 4): string => arr.slice(0, n).map((s) => s.name).join(', ');

  const services = named(/Service$/);
  const managers = named(/Manager$/);
  const controllers = named(/Controller$/);
  const views = named(/(View|Screen|Panel|Window|Popup|Page)$/);
  const presenters = named(/Presenter$/);
  const viewModels = named(/ViewModel$/);
  const models = named(/(Model|Data|Entity)$/);
  const repos = named(/(Repository|Repo|Store)$/);

  // dependency direction evidence
  const depEdges = relationships.filter((r) => r.type === 'depends_on' || r.type === 'references' || r.type === 'injects');
  const countEdges = (from: SymbolInfo[], to: SymbolInfo[]): number => {
    const a = new Set(from.map((s) => s.id));
    const b = new Set(to.map((s) => s.id));
    return depEdges.filter((r) => a.has(r.source) && b.has(r.target)).length;
  };

  if (services.length >= 3) {
    const svcToUi = countEdges(services, views);
    const ctrlToSvc = countEdges([...controllers, ...presenters, ...managers], services);
    out.push({
      name: 'Service-oriented', category: 'primary', confidence: conf(services.length + ctrlToSvc, 12) * (svcToUi > services.length / 2 ? 0.7 : 1),
      evidence: [
        `${services.length} classes named *Service (${ex(services)})`,
        ctrlToSvc ? `${ctrlToSvc} dependencies from controllers/managers to services` : '',
        svcToUi === 0 ? 'Services never depend on UI types' : `${svcToUi} service → UI dependencies (unusual)`,
      ].filter(Boolean),
    });
  }
  if (managers.length >= 3) {
    out.push({
      name: 'Manager-based', category: 'primary', confidence: conf(managers.length, 6),
      evidence: [`${managers.length} classes named *Manager (${ex(managers)})`, `${Math.round((managers.length / total) * 100)}% of classes`],
    });
  }
  const monoBehaviours = classes.filter((s) => s.baseTypes?.some((b) => /^(MonoBehaviour|NetworkBehaviour|SerializedMonoBehaviour)$/.test(b)));
  if (monoBehaviours.length >= 5) {
    out.push({
      name: 'Component-based (Unity MonoBehaviour)', category: 'primary', confidence: Math.min(0.95, monoBehaviours.length / total + 0.3),
      evidence: [`${monoBehaviours.length} MonoBehaviour subclasses (${ex(monoBehaviours)})`],
    });
  }
  const ecs = types.filter((s) => s.baseTypes?.some((b) => /^(IComponentData|ISystem|SystemBase|IJobEntity|IBufferElementData|IAspect)$/.test(b)));
  if (ecs.length >= 3 || frameworks.includes('Unity ECS (DOTS)')) {
    out.push({ name: 'ECS (Entity Component System)', category: 'primary', confidence: conf(ecs.length + 3, 6), evidence: [`${ecs.length} ECS components/systems (${ex(ecs)})`] });
  }
  if (controllers.length >= 2 && views.length >= 2 && models.length >= 2) {
    out.push({
      name: 'MVC', category: 'presentation', confidence: conf(Math.min(controllers.length, views.length, models.length), 4),
      evidence: [`${controllers.length} controllers, ${views.length} views, ${models.length} models`, `${countEdges(controllers, views)} controller → view dependencies`],
    });
  }
  if (presenters.length >= 2 && views.length >= 1) {
    out.push({ name: 'MVP', category: 'presentation', confidence: conf(presenters.length, 3), evidence: [`${presenters.length} presenters (${ex(presenters)})`, `${countEdges(presenters, views)} presenter → view dependencies`] });
  }
  if (viewModels.length >= 2) {
    out.push({ name: 'MVVM', category: 'presentation', confidence: conf(viewModels.length, 3), evidence: [`${viewModels.length} view models (${ex(viewModels)})`] });
  }
  if (!presenters.length && !viewModels.length && controllers.length >= 2 && views.length >= 2 && !(models.length >= 2)) {
    out.push({ name: 'View + Controller', category: 'presentation', confidence: conf(controllers.length, 4), evidence: [`${views.length} views, ${controllers.length} controllers`] });
  }
  if (repos.length >= 1) {
    out.push({ name: 'Repository pattern', category: 'secondary', confidence: conf(repos.length * 2, 4), evidence: [`${repos.length} repositories/stores (${ex(repos)})`] });
  }

  // Families: an abstraction with >= 3 implementations
  const implCount = new Map<string, SymbolInfo[]>();
  for (const r of relationships) if (r.type === 'implements' || r.type === 'inherits') {
    const arr = implCount.get(r.target) ?? [];
    const s = byId.get(r.source);
    if (s) arr.push(s);
    implCount.set(r.target, arr);
  }
  const familyNamed = (re: RegExp): { base: SymbolInfo; impls: SymbolInfo[] }[] =>
    [...implCount].map(([b, impls]) => ({ base: byId.get(b)!, impls })).filter((f) => f.base && f.impls.length >= 2 && (re.test(f.base.name) || f.impls.filter((i) => re.test(i.name)).length >= 2));
  const commands = familyNamed(/(Command|Action)$/);
  if (commands.length) {
    const n = commands.reduce((a, f) => a + f.impls.length, 0);
    out.push({ name: 'Command / Action pattern', category: 'secondary', confidence: conf(n, 4), evidence: commands.slice(0, 3).map((f) => `${f.base.name} ← ${ex(f.impls, 3)}${f.impls.length > 3 ? ` (+${f.impls.length - 3})` : ''}`) });
  }
  const states = familyNamed(/State$/);
  const fsm = named(/(StateMachine|Fsm|FSM)$/);
  if (states.length || fsm.length) {
    out.push({ name: 'State pattern', category: 'secondary', confidence: conf(states.reduce((a, f) => a + f.impls.length, 0) + fsm.length * 2, 4), evidence: [...fsm.slice(0, 2).map((s) => `state machine: ${s.name}`), ...states.slice(0, 2).map((f) => `${f.base.name} ← ${ex(f.impls, 3)}`)] });
  }
  const strategies = familyNamed(/(Strategy|Policy|Provider|Calculator|Handler)$/).filter((f) => f.base.kind === 'interface' || f.base.modifiers?.includes('abstract'));
  if (strategies.length) {
    out.push({ name: 'Strategy pattern', category: 'secondary', confidence: conf(strategies.length * 2, 4), evidence: strategies.slice(0, 3).map((f) => `${f.base.name} has ${f.impls.length} interchangeable implementations`) });
  }
  const factories = named(/Factory$/);
  if (factories.length >= 2) out.push({ name: 'Factory pattern', category: 'secondary', confidence: conf(factories.length, 3), evidence: [`${factories.length} factories (${ex(factories)})`] });
  const singletons = symbols.filter((s) => s.kind === 'property' || s.kind === 'field').filter((s) => /^(Instance|instance|_instance|Shared|Default)$/.test(s.name) && s.modifiers?.includes('static'));
  if (singletons.length >= 2) {
    out.push({ name: 'Singleton', category: 'secondary', confidence: conf(singletons.length, 3), evidence: [`${singletons.length} static Instance members (${singletons.slice(0, 4).map((s) => s.qualifiedName.split('.').slice(-2, -1)[0]).join(', ')})`] });
  }

  const subs = relationships.filter((r) => r.type === 'subscribes_to').length;
  const pubs = relationships.filter((r) => r.type === 'publishes').length;
  const buses = named(/(EventBus|MessageBus|Signal|SignalBus|EventManager|EventDispatcher|MessageBroker|Events|EventHub)$/);
  if (subs + pubs >= 8 || buses.length || frameworks.some((f) => ['R3', 'UniRx', 'RxJS', 'MessagePipe'].includes(f))) {
    out.push({
      name: 'Event-driven', category: 'infrastructure', confidence: conf(subs + pubs + buses.length * 5, 20),
      evidence: [`${subs} event subscriptions, ${pubs} publications`, buses.length ? `event hubs: ${ex(buses)}` : '', ...frameworks.filter((f) => ['R3', 'UniRx', 'RxJS', 'MessagePipe'].includes(f)).map((f) => `uses ${f}`)].filter(Boolean),
    });
  }
  if (di.registrations.length) {
    const scopes = new Set(di.registrations.map((r) => r.scopeSymbol));
    out.push({
      name: 'Dependency Injection', category: 'infrastructure', confidence: conf(di.registrations.length + di.injections.length, 6),
      evidence: [`${di.containers.join(', ')} container`, `${di.registrations.length} registrations in ${scopes.size} scope${scopes.size === 1 ? '' : 's'}`, `${di.injections.length} injection points`],
    });
  } else if (di.injections.length >= 5) {
    out.push({ name: 'Constructor injection (manual)', category: 'infrastructure', confidence: conf(di.injections.length, 10), evidence: [`${di.injections.length} injection points without a detected container`] });
  }

  // Layered / Clean / Hexagonal (folder vocabulary + dependency direction)
  const folderHits = (re: RegExp): number => files.filter((f) => re.test(f)).length;
  const domain = folderHits(/(^|\/)Domain(\/|$)/i);
  const application = folderHits(/(^|\/)(Application|UseCases?)(\/|$)/i);
  const infra = folderHits(/(^|\/)Infrastructure(\/|$)/i);
  const ports = folderHits(/(^|\/)(Ports?|Adapters?)(\/|$)/i);
  if (domain && infra && application) {
    out.push({ name: 'Clean Architecture', category: 'primary', confidence: 0.6 + Math.min(0.3, (domain + application + infra) / 200), evidence: [`Domain (${domain} files), Application/UseCases (${application}), Infrastructure (${infra}) folders`] });
  }
  if (ports >= 2) out.push({ name: 'Hexagonal (Ports & Adapters)', category: 'primary', confidence: 0.55 + Math.min(0.3, ports / 60), evidence: [`${ports} files in Ports/Adapters folders`] });

  // Layered: share of cross-layer edges pointing "down"
  let down = 0;
  let up = 0;
  for (const r of depEdges) {
    const a = byId.get(r.source);
    const b = byId.get(r.target);
    const ra = layerRank(a?.layer);
    const rb = layerRank(b?.layer);
    if (ra === undefined || rb === undefined || ra === rb) continue;
    if (ra < rb) down++;
    else up++;
  }
  const layersUsed = new Set(types.map((t) => t.layer).filter(Boolean));
  if (down + up >= 10 && layersUsed.size >= 3) {
    const ratio = down / (down + up);
    if (ratio >= 0.7) {
      out.push({ name: 'Layered architecture', category: 'primary', confidence: Math.min(0.95, ratio - 0.05), evidence: [`${Math.round(ratio * 100)}% of ${down + up} cross-layer dependencies point downward`, `${layersUsed.size} layers detected`] });
    }
  }
  return out.filter((p) => p.confidence >= 0.25).sort((a, b) => b.confidence - a.confidence);
}
