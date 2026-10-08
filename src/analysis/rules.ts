import YAML from 'yaml';
import { Finding, SymbolInfo, TYPE_KINDS } from '../model/types';
import { GraphIndex } from './graph';
import { globToRegExp } from '../scanner/glob';

/**
 * Project-specific architecture rules (.architecture-rules.yaml):
 *
 * rules:
 *   - name: Gameplay cannot depend on UI
 *     from: Gameplay            # layer, module name/path, or a name pattern like "*Service"
 *     cannot_depend_on: UI
 *   - name: No singletons
 *     forbid: Singleton
 *   - name: Use DI for services
 *     type: dependency_injection
 */
export interface ArchitectureRule {
  name: string;
  from?: string;
  cannot_depend_on?: string | string[];
  forbid?: string;
  type?: string;
  severity?: 'info' | 'warning' | 'error';
}

export const RULES_FILE_NAMES = ['.architecture-rules.yaml', '.architecture-rules.yml', 'architecture-rules.yaml'];

export const RULES_TEMPLATE = `# Architecture rules checked on every analysis.
# Selectors match a layer name (UI, Controller, Gameplay, Service, Data, Infrastructure, Composition),
# a module name or path, or a type-name glob such as "*Service" or "Game.Farming.*".
rules:
  - name: Gameplay cannot depend on UI
    from: Gameplay
    cannot_depend_on: UI

  - name: Services cannot depend on Views
    from: "*Service"
    cannot_depend_on: ["*View", "*Screen", "*Panel"]

  - name: Use DI for services
    type: dependency_injection

  - name: No singletons
    forbid: Singleton
`;

export function parseRules(text: string): { rules: ArchitectureRule[]; error?: string } {
  try {
    const doc = YAML.parse(text) as { rules?: ArchitectureRule[] } | null;
    const rules = (doc?.rules ?? []).filter((r) => r && typeof r === 'object' && r.name);
    return { rules };
  } catch (e) {
    return { rules: [], error: String(e) };
  }
}

function selector(sel: string): (s: SymbolInfo, graph: GraphIndex) => boolean {
  const re = sel.includes('*') || sel.includes('?') ? globToRegExp(sel) : undefined;
  return (s, graph) => {
    if (s.layer && s.layer.toLowerCase() === sel.toLowerCase()) return true;
    const mod = s.module ? graph.moduleById.get(s.module) : undefined;
    if (mod && (mod.name.toLowerCase() === sel.toLowerCase() || mod.path.toLowerCase() === sel.toLowerCase())) return true;
    if (re) return re.test(s.name) || re.test(s.qualifiedName);
    return s.name === sel || s.qualifiedName === sel;
  };
}

export function checkRules(rules: ArchitectureRule[], graph: GraphIndex): Finding[] {
  const out: Finding[] = [];
  const types = graph.model.symbols.filter((s) => TYPE_KINDS.has(s.kind));
  for (const rule of rules) {
    const severity = rule.severity ?? 'warning';
    if (rule.from && rule.cannot_depend_on) {
      const from = selector(rule.from);
      const targets = (Array.isArray(rule.cannot_depend_on) ? rule.cannot_depend_on : [rule.cannot_depend_on]).map(selector);
      let n = 0;
      for (const s of types) {
        if (!from(s, graph)) continue;
        for (const d of graph.dependencies(s.id)) {
          if (from(d.symbol, graph) || !targets.some((t) => t(d.symbol, graph))) continue;
          if (n++ > 200) break;
          out.push({
            kind: 'rule-violation',
            severity,
            title: `${rule.name}: ${s.name} → ${d.symbol.name}`,
            detail: `Rule "${rule.name}" violated (${d.types.join(', ')}).`,
            symbols: [s.id, d.symbol.id],
            location: d.rels[0]?.location ?? { file: s.file, line: s.startLine },
          });
        }
      }
    }
    if (rule.forbid && /singleton/i.test(rule.forbid)) {
      for (const s of graph.model.symbols) {
        if ((s.kind === 'property' || s.kind === 'field') && s.modifiers?.includes('static') && /^(Instance|instance|_instance|s_Instance)$/.test(s.name)) {
          const owner = s.parent ? graph.get(s.parent) : undefined;
          out.push({ kind: 'rule-violation', severity, title: `${rule.name}: ${owner?.name ?? s.name}`, detail: `Static singleton accessor ${s.qualifiedName}.`, symbols: [owner?.id ?? s.id], location: { file: s.file, line: s.startLine } });
        }
      }
    }
    if (rule.type === 'dependency_injection') {
      for (const r of graph.model.relationships) {
        if (r.type !== 'creates') continue;
        const target = graph.get(r.target);
        const source = graph.get(r.source);
        if (!target || !source || !/(Service|Manager|Repository|Provider)$/.test(target.name) || source.layer === 'Composition') continue;
        out.push({ kind: 'rule-violation', severity, title: `${rule.name}: ${source.name} creates ${target.name}`, detail: `${target.name} is constructed with "new" instead of being injected.`, symbols: [source.id, target.id], location: r.location });
      }
    }
  }
  return out;
}
