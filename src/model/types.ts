// Core architecture model. Everything here is produced by deterministic analysis;
// AI output is stored separately and always references these ids.

export type Language = 'csharp' | 'typescript' | 'javascript' | 'json' | 'other';

export type FileType =
  | 'source'
  | 'test'
  | 'configuration'
  | 'dependency-config'
  | 'unity-asset'
  | 'unity-scene'
  | 'unity-prefab'
  | 'generated'
  | 'other';

export interface FileInfo {
  path: string; // workspace-relative, forward slashes
  language: Language;
  type: FileType;
  size: number;
  hash: string;
  role?: string; // e.g. "UI", "class", "configuration"
}

export type SymbolKind =
  | 'namespace'
  | 'class'
  | 'interface'
  | 'struct'
  | 'enum'
  | 'record'
  | 'type'
  | 'function'
  | 'variable'
  | 'method'
  | 'constructor'
  | 'property'
  | 'field';

export const TYPE_KINDS: ReadonlySet<SymbolKind> = new Set(['class', 'interface', 'struct', 'enum', 'record', 'type']);
export const CALLABLE_KINDS: ReadonlySet<SymbolKind> = new Set(['method', 'constructor', 'function']);

export interface Location {
  file: string;
  line: number; // 1-based
}

export interface SymbolInfo {
  id: string; // stable: "<file>#<Qualified.Name>[(arity)]"
  name: string;
  qualifiedName: string; // Namespace.Type.Member
  kind: SymbolKind;
  language: Language;
  file: string;
  namespace?: string;
  parent?: string; // id of containing type
  visibility?: string;
  modifiers?: string[];
  attributes?: string[];
  baseTypes?: string[]; // raw names as written
  parameters?: string[]; // parameter type names
  returnType?: string;
  startLine: number;
  endLine: number;
  exported?: boolean;
  module?: string; // module id
  layer?: string; // layer name
}

export type RelationshipType =
  | 'contains'
  | 'inherits'
  | 'implements'
  | 'depends_on'
  | 'calls'
  | 'creates'
  | 'references'
  | 'imports'
  | 'injects'
  | 'registers'
  | 'subscribes_to'
  | 'publishes';

export interface Relationship {
  source: string;
  target: string;
  type: RelationshipType;
  confidence: number; // 0..1, < 1 when name-based resolution was ambiguous
  location?: Location;
  detail?: string;
}

/**
 * Per-file parser output. References are unresolved names; the resolver turns them
 * into Relationships once every file has been parsed. This is what gets cached per file hash.
 */
export interface RawReference {
  from: string; // symbol id
  name: string; // name as written, may be qualified "A.B" or member "x.Method"
  kind: 'type' | 'call' | 'new' | 'inherit' | 'import' | 'member-call' | 'event-sub' | 'event-pub';
  line: number;
  receiverType?: string; // resolved type of receiver for member calls, when locally known
  arity?: number;
}

export interface RawDIRegistration {
  file: string;
  line: number;
  container: string; // e.g. "VContainer", "Zenject", "MS.DI", "tsyringe", "inversify"
  scopeSymbol?: string; // symbol id of the installer / lifetime scope
  service: string; // type name exposed
  implementation: string; // concrete type name
  lifetime?: string;
  method: string; // e.g. "Register", "RegisterEntryPoint", "Bind"
}

export interface RawInjectionPoint {
  consumer: string; // symbol id of the consuming type
  type: string; // injected type name
  line: number;
  via: 'constructor' | 'attribute' | 'decorator' | 'method';
}

export interface ParsedFile {
  file: string;
  hash: string;
  language: Language;
  usings: string[]; // C# usings / TS import module specifiers
  imports: { name: string; from: string; alias?: string }[]; // TS named imports
  symbols: SymbolInfo[];
  references: RawReference[];
  di: RawDIRegistration[];
  injections: RawInjectionPoint[];
  methodFingerprints: { id: string; tokens: number; shingles: number[] }[];
  errors?: string[];
}

export interface ModuleInfo {
  id: string;
  name: string;
  path: string; // folder
  files: string[];
  symbols: string[]; // type-level symbol ids
  layer?: string;
  description?: string;
  dependsOn: Record<string, number>; // module id -> edge weight
}

export interface LayerInfo {
  name: string;
  rank: number; // lower = closer to the user (presentation)
  symbols: number;
  evidence: string[];
}

export interface PatternFinding {
  name: string;
  category: 'primary' | 'secondary' | 'infrastructure' | 'presentation';
  confidence: number; // 0..1
  evidence: string[];
}

export type FindingSeverity = 'info' | 'warning' | 'error';

export interface Finding {
  kind:
    | 'god-object'
    | 'circular-dependency'
    | 'layer-violation'
    | 'excessive-coupling'
    | 'dead-code'
    | 'duplicate-logic'
    | 'rule-violation';
  severity: FindingSeverity;
  title: string;
  detail: string;
  symbols: string[];
  location?: Location;
}

export interface DIRegistration extends RawDIRegistration {
  serviceId?: string;
  implementationId?: string;
}

export interface DIInfo {
  containers: string[];
  registrations: DIRegistration[];
  injections: (RawInjectionPoint & { typeId?: string; providers: number[] })[]; // providers -> indexes into registrations
}

export interface ProjectInfo {
  root: string;
  name: string;
  languages: Record<string, number>;
  frameworks: string[];
  packageManagers: string[];
  sourceFolders: string[];
  testFolders: string[];
  configFiles: string[];
  fileTypes: Record<string, number>;
}

export interface ArchitectureModel {
  version: number;
  analyzedAt: string;
  durationMs: number;
  project: ProjectInfo;
  files: FileInfo[];
  symbols: SymbolInfo[];
  relationships: Relationship[];
  modules: ModuleInfo[];
  layers: LayerInfo[];
  patterns: PatternFinding[];
  findings: Finding[];
  di: DIInfo;
  stats: {
    files: number;
    sourceFiles: number;
    types: number;
    methods: number;
    relationships: number;
    parsedFiles: number;
    cachedFiles: number;
  };
}

export const MODEL_VERSION = 1;
