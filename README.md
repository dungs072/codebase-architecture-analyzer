# Codebase Architecture Analyzer (VS Code extension)

Turns an unfamiliar codebase into an interactive, evidence-backed architecture map.

> Deterministic analysis discovers facts. AI explains those facts.

Supports **C#** (Unity, .NET; VContainer / Zenject / Microsoft.Extensions.DependencyInjection) and **TypeScript / JavaScript** (inversify, tsyringe, Angular/Nest-style decorators, Cocos Creator).

## Quick start

```bash
npm install
npm run build          # bundles dist/extension.js and copies cytoscape into media/vendor
npm test               # headless engine tests against test-fixtures/
npm run test:integration   # boots a real VS Code extension host on the Unity fixture
```

Press **F5** ("Run Extension (Unity fixture)") to open a development window on the sample project, or install the packaged `.vsix` (`npm run package`, then *Extensions → … → Install from VSIX*).

In the target project: **Architecture: Analyze Project**, then click the status-bar item or **Architecture: Open Architecture Map**.

Headless analysis of any folder (useful for debugging the analyzer): `node dist/cli.js <folder> [--json model.json]`.

## What you get

| Plan feature | Where |
|---|---|
| Project overview (languages, frameworks, package managers, source/test folders) | *Architecture* sidebar → Overview |
| Architecture detection with confidence + evidence (Service-oriented, Manager-based, MVC/MVP/MVVM, Layered, Clean, Hexagonal, ECS, Command, State, Strategy, Factory, Singleton, Event-driven, DI) | Overview → Detected Architecture; map toolbar |
| Layers inferred from what the project actually uses (Composition, UI, Controller, Gameplay, Service, Data, Infrastructure) | Overview → Layers; *Modules & Layers* view |
| Module detection (folders, oversized folders split, third-party marked) | *Modules & Layers* view, map level 1 |
| Architecture map with progressive disclosure: modules → classes → methods; layered / force / grid layouts; zoom, pan, focus, hide unrelated, edge-type filters, highlight dependencies (blue) / dependents (orange), trace path | **Architecture Map** panel |
| Symbol inspector: type, file, layer, module, dependencies, used-by, members, DI wiring, findings, change risk | Map → Inspector tab (click any node, tree item, or *Inspect Symbol at Cursor*) |
| Call graph: callers / callees trees with depth | Inspector buttons, node right-click, *Show Callers / Show Callees* |
| Dependency injection: registration → resolution → injection → consumer; "where does this service come from?" | *Dependency Injection* view, Inspector |
| Change impact ("What could break?"): direct / indirect dependents, modules affected, DI registrations, event subscriptions, risk + AI explanation | *Analyze Impact* (editor context menu, node menu) |
| Feature flow tracing ("How does hiring staff work?") ordered UI → … → Data, with files involved | *Trace Feature Flow*, map toolbar |
| Smells: God Object, circular dependencies (module + type), layer violations, excessive coupling, potentially unused code, duplicate logic | *Findings* view, Inspector |
| Project rules (`.architecture-rules.yaml`) | *Create Architecture Rules File* |
| AI: explain class / module / project, onboarding course ("Teach me this project"), codebase chat | Map AI tab, *Codebase Chat* panel |
| ARCHITECTURE.md generation (facts + optional AI overview, mermaid module graph, every item linked to code) | *Generate ARCHITECTURE.md* |
| Search (classes, methods, files, modules, camel-case initials) | Map search box, *Search Architecture* |
| Navigation: open file, go to definition, find references (language server first, graph fallback), callers, callees, dependencies, dependents | Everywhere; editor context menu |
| Incremental analysis by file hash, analysis history snapshots | automatic; Overview → Analysis History |

## AI providers

AI only ever receives structured facts from the graph plus selected source snippets, never the whole repository, and is instructed to cite `path:line` (citations are clickable).

- **VS Code language model** (default): uses any model provided through the VS Code LM API, e.g. GitHub Copilot. No key needed. Pick a family with `archAnalyzer.ai.vscodeModelFamily`.
- **Anthropic API**: run *Architecture: Set Anthropic API Key* (stored in VS Code secret storage) and set `archAnalyzer.ai.provider` to `anthropic`. Default model `claude-opus-5-5`, effort `medium` (`archAnalyzer.ai.effort`). Requests enable the API's server-side refusal fallback (`fallbacks: "default"`), so a declined request is retried on a fallback model instead of failing.

Everything except the AI features works offline.

## Architecture rules

```yaml
# .architecture-rules.yaml (project root)
rules:
  - name: Gameplay cannot depend on UI
    from: Gameplay            # layer, module name/path, or a type glob like "*Service"
    cannot_depend_on: UI
  - name: No singletons
    forbid: Singleton
  - name: Use DI for services
    type: dependency_injection
```

Violations appear under *Findings → Rule Violations* after each analysis (saving the rules file re-runs it).

## How it works

```
scanner/      file discovery, .gitignore, language + framework detection, file classification, hashing
parsers/      C#: hand-written tokenizer + structural parser (no native deps)
              TS/JS: TypeScript compiler syntax API (no type checker → fast)
              both emit symbols + unresolved references + DI registrations + injection points
analysis/     resolver      names → typed relationships (usings/namespaces, imports/barrels/path aliases,
                            member chains like a.B.C.Method() across files), confidence < 1 when ambiguous
              graph         query engine: callers/callees, dependencies/dependents, impact, paths, SCCs, search
              architecture  modules, layers, patterns (with evidence)
              smells/rules  findings
              features      deterministic feature-flow tracing
ai/           provider (VS Code LM / Anthropic SDK, streaming), context builders (evidence-based prompts)
storage/      parse cache keyed by file hash, model, history (JSON in the extension's workspace storage)
ui/ + media/  tree views, Architecture Map (cytoscape webview), chat webview
```

Relationship types: `contains, inherits, implements, depends_on, calls, creates, references, imports, injects, registers, subscribes_to, publishes`.

## Known limitations / next steps

- Name-based resolution, not full semantic analysis: overloads are matched by arity; calls through generics, lambdas returned from methods, `GetComponent()` without a type argument, or `var` locals initialized from method calls may stay unresolved (they are simply not drawn). Ambiguous matches carry confidence < 1 and are marked "uncertain".
- C# preprocessor branches are all parsed (`#if` both sides).
- Storage is JSON rather than SQLite (no native module to ship per platform); the data model maps 1:1 to the tables in the plan, so moving to SQLite (e.g. sql.js) later is mechanical.
- Unity scene/prefab references (script GUIDs) are not yet read, so engine-instantiated types are excluded from dead-code detection instead of being proven used.
- Not yet built (Phase 2/3): Git integration (churn, risky files), project comparison, statement-level graph (level 4), Rider/Visual Studio integration, refactoring suggestions, layer rename/merge UI.
