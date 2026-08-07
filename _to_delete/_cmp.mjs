import { readSourceDirect as rsdNew, buildDirectContext as bdcNew } from './src/lib/rag/discovery.js';
import { buildDirectContext as bdcOld } from './src/lib/rag/_discoveryOld.js';
import { extractModuleCapabilities } from './src/lib/rag/codeSignals.js';
import { extractFormSchema } from './src/lib/rag/formSchema.js';
const row = (tag, ctx) => {
  const c = extractModuleCapabilities(ctx.uiContext);
  const s = extractFormSchema(ctx.uiContext);
  console.log(`  ${tag.padEnd(6)} edit=${String(c.listHasEdit).padEnd(5)} view=${String(c.listHasView).padEnd(5)} delMode=${String(c.deleteMode).padEnd(11)} search=${String(c.searchTestId).padEnd(20)} fields=${String((s.fields||[]).length).padEnd(3)} withTestId=${String((s.fields||[]).filter(f=>f.testId).length).padEnd(3)} filterKeys=${JSON.stringify(s.filterKeys)}`);
};
for (const mod of ['currency','vat','partner','eco-tax','retail-chain']) {
  const d = await rsdNew([mod]);
  if (!d.ui.length) { console.log('=== ' + mod + ' === (no ui files found)'); continue; }
  console.log('=== ' + mod + ' ===');
  row('BEFORE', bdcOld(d, mod));
  row('AFTER', bdcNew(d, mod));
}
