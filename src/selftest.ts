// Headless test of the analysis engine against the fixtures in test-fixtures/.
// Run with: npm test
import * as path from 'path';
import { analyzeProject } from './analysis/analyzer';
import { traceFeature } from './analysis/features';
import { RelationshipType } from './model/types';

let failures = 0;
function check(cond: boolean, msg: string): void {
  if (cond) console.log(`  ✓ ${msg}`);
  else {
    failures++;
    console.log(`  ✗ ${msg}`);
  }
}

const opts = {
  exclude: ['**/node_modules/**', '**/Library/**'],
  maxFiles: 5000,
  smells: { godObjectDependencies: 12, godObjectMethods: 30, couplingThreshold: 8 },
};

async function unity(): Promise<void> {
  console.log('\nUnity / VContainer fixture');
  const { model, graph } = await analyzeProject(path.resolve('test-fixtures/unity-farm'), opts);
  const sym = (qn: string) => model.symbols.find((s) => s.qualifiedName === qn);
  const has = (src: string, dst: string, type: RelationshipType) => {
    const a = sym(src);
    const b = sym(dst);
    return !!a && !!b && model.relationships.some((r) => r.source === a.id && r.target === b.id && r.type === type);
  };
  console.log(`  ${model.stats.sourceFiles} files, ${model.stats.types} types, ${model.stats.methods} methods, ${model.stats.relationships} relationships in ${model.durationMs}ms`);
  check(['Unity', 'VContainer', 'R3', 'DOTween'].every((f) => model.project.frameworks.includes(f)), `frameworks detected: ${model.project.frameworks.join(', ')}`);
  check(!!sym('Game.Farming.FarmManager'), 'FarmManager class extracted');
  check(has('Game.Farming.FarmManager', 'Game.Farming.CropService', 'depends_on'), 'FarmManager depends_on CropService');
  check(has('Game.Farming.PlantCropAction', 'Game.Farming.GameAction', 'inherits'), 'PlantCropAction inherits GameAction');
  check(has('Game.Core.TimeService', 'Game.Core.ITimeService', 'implements'), 'TimeService implements ITimeService');
  check(has('Game.UI.FarmController', 'Game.Farming.PlantCropAction', 'creates'), 'FarmController creates PlantCropAction');
  check(has('Game.Farming.FarmManager.PlantCrop', 'Game.Farming.CropService.Plant', 'calls'), 'FarmManager.PlantCrop calls CropService.Plant');
  check(has('Game.Farming.CropService.Plant', 'Game.Core.IInventoryService.RemoveSeed', 'calls'), 'CropService.Plant calls IInventoryService.RemoveSeed (via field type)');
  check(has('Game.UI.FarmScreen.Awake', 'Game.UI.FarmScreen.OnPlantClicked', 'calls'), 'method group AddListener(OnPlantClicked) recorded as call');
  check(has('Game.Farming.FarmManager', 'Game.Core.ITimeService.OnTick', 'subscribes_to'), 'FarmManager subscribes_to ITimeService.OnTick');
  check(has('Game.Core.TimeService', 'Game.Core.TimeService.OnTick', 'publishes'), 'TimeService publishes OnTick');
  check(has('Game.Staff.HiringService.Hire', 'Game.Core.CurrencyService.TrySpend', 'calls'), 'HiringService.Hire calls CurrencyService.TrySpend');

  const regs = model.di.registrations;
  check(regs.length >= 9, `${regs.length} VContainer registrations`);
  check(regs.some((r) => r.service === 'ITimeService' && r.implementation === 'TimeService' && r.lifetime === 'Singleton'), 'Register<TimeService>().As<ITimeService>() resolved');
  check(regs.some((r) => r.service === 'IInventoryService' && r.method === 'Register'), 'AsImplementedInterfaces expanded to IInventoryService');
  check(regs.some((r) => r.implementation === 'FarmScreen' && r.method === 'RegisterComponent'), 'RegisterComponent(field) uses the field type');
  check(regs.some((r) => r.implementation === 'WeatherSystem' && !!r.implementationId), 'RegisterComponent(root.Systems.Weather) resolved through a member chain');
  check(has('Game.Core.GameRoot.Update', 'Game.Core.WeatherSystem.Rain', 'calls'), 'chained call Systems.Weather.Rain() resolved across types');
  const cropInj =model.di.injections.find((i) => i.consumer === sym('Game.Farming.FarmManager')?.id && i.type === 'CropService');
  check(!!cropInj && cropInj.providers.length === 1, 'FarmManager ← CropService injection traced to its registration');
  check(model.di.injections.some((i) => i.via === 'attribute' && i.type === 'FarmController'), '[Inject] field injection detected');

  const mods = model.modules.map((m) => m.name).sort();
  check(['Animals', 'Core', 'Farming', 'Staff', 'UI'].every((m) => mods.includes(m)), `modules: ${mods.join(', ')}`);
  check(sym('Game.UI.FarmScreen')?.layer === 'UI' && sym('Game.Farming.CropService')?.layer === 'Service' && sym('Game.Core.GameLifetimeScope')?.layer === 'Composition', 'layers inferred (UI / Service / Composition)');
  check(model.patterns.some((p) => p.name === 'Service-oriented'), `patterns: ${model.patterns.map((p) => `${p.name} ${Math.round(p.confidence * 100)}%`).join(', ')}`);
  check(model.patterns.some((p) => p.name === 'Dependency Injection'), 'Dependency Injection pattern detected');

  const f = (k: string, t: string) => model.findings.some((x) => x.kind === k && x.title.includes(t));
  check(f('layer-violation', 'CropService'), 'layer violation CropService → FarmScreen');
  check(f('duplicate-logic', 'CalculateGrowth'), 'duplicate CalculateGrowth detected');
  check(f('dead-code', 'UnusedHelper'), 'UnusedHelper flagged as potentially unused');
  check(f('dead-code', 'NeverCalled'), 'NeverCalled flagged as unused private method');
  check(!f('dead-code', 'OnPlantClicked') && !f('dead-code', 'HandleTick'), 'handlers used as method groups are not flagged');

  const flow = traceFeature(graph, 'How does hiring staff work?');
  const flowNames = flow.steps.flatMap((s) => s.symbols.map((x) => x.name));
  check(['HiringScreen', 'HiringController', 'HiringService', 'StaffRepository'].every((n) => flowNames.includes(n)), `feature flow: ${flow.steps.map((s) => `${s.layer}[${s.symbols.map((x) => x.name).join(',')}]`).join(' → ')}`);
  const ui = flow.steps.findIndex((s) => s.symbols.some((x) => x.name === 'HiringScreen'));
  const svc = flow.steps.findIndex((s) => s.symbols.some((x) => x.name === 'HiringService'));
  check(ui >= 0 && svc > ui, 'flow ordered UI before Service');

  const impact = graph.impact([sym('Game.Farming.CropService')!.id]);
  check(impact.direct.some((d) => d.symbol.name === 'FarmManager'), `impact(CropService): risk ${impact.risk}, direct: ${impact.direct.map((d) => d.symbol.name).join(', ')}; indirect: ${impact.indirect.map((d) => d.symbol.name).join(', ')}`);
  check(impact.indirect.some((d) => d.symbol.name === 'FarmController' || d.symbol.name === 'PlantCropAction'), 'impact reaches indirect dependents');

  const tree = graph.callTree(sym('Game.UI.FarmController.Plant')!.id, 'callees', 4);
  const flat: string[] = [];
  const walk = (n: typeof tree, d = 0) => { if (!n) return; flat.push('  '.repeat(d) + n.symbol.qualifiedName.split('.').slice(-2).join('.')); n.children.forEach((c) => walk(c, d + 1)); };
  walk(tree);
  check(flat.some((x) => x.includes('CropService.Plant')), `call flow from FarmController.Plant:\n      ${flat.join('\n      ')}`);
  check(graph.search('FM').some((h) => h.label === 'FarmManager'), 'search by camel-case initials');
}

async function typescript(): Promise<void> {
  console.log('\nTypeScript / inversify fixture');
  const { model } = await analyzeProject(path.resolve('test-fixtures/ts-app'), opts);
  const sym = (qn: string, file?: string) => model.symbols.find((s) => s.qualifiedName === qn && (!file || s.file.includes(file)));
  const has = (a?: string, b?: string, type?: RelationshipType) => !!a && !!b && model.relationships.some((r) => r.source === a && r.target === b && r.type === type);
  console.log(`  ${model.stats.sourceFiles} files, ${model.stats.types} types, ${model.stats.relationships} relationships`);
  check(model.project.frameworks.includes('InversifyJS') && model.project.frameworks.includes('React'), `frameworks: ${model.project.frameworks.join(', ')}`);
  check(has(sym('PaymentService')?.id, sym('UserRepository')?.id, 'depends_on'), 'PaymentService depends_on UserRepository (constructor parameter property, via import)');
  check(has(sym('CheckoutView.onPayClicked')?.id, sym('PaymentService.charge')?.id, 'calls'), 'CheckoutView.onPayClicked calls PaymentService.charge (this.payments typed)');
  check(has(sym('PaymentService.charge')?.id, sym('UserRepository.save')?.id, 'calls'), 'PaymentService.charge calls UserRepository.save');
  check(model.di.registrations.filter((r) => r.container === 'inversify').length === 2, `inversify registrations: ${model.di.registrations.length}`);
  check(model.di.injections.some((i) => i.type === 'UserRepository' && i.providers.length === 1), 'constructor injection traced to inversify binding');
  check(sym('CheckoutView')?.layer === 'UI', 'TSX view classified as UI');
}

(async () => {
  await unity();
  await typescript();
  console.log(failures ? `\n${failures} check(s) failed` : '\nAll checks passed');
  process.exit(failures ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
