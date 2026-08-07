// Prisma-free stand-in for extractCodeVocabulary (ground.js pulls in @prisma/client,
// whose engine binary is darwin-only in this checkout).
import { readSourceDirect, buildDirectContext } from '../src/lib/rag/discovery.js';
import { extractFormSchema } from '../src/lib/rag/formSchema.js';
import { auditCodeTestIds } from '../src/lib/rag/codeTestIds.js';

const testIdsFrom = (html) => [...new Set([
  ...[...String(html).matchAll(/data-testid="([^"]+)"/gi)].map(m => m[1]),
  ...[...String(html).matchAll(/\[?testId\]?="'?([^"']+)'?"/gi)].map(m => m[1]),
])];

for (const m of process.argv.slice(2)) {
  const d = await readSourceDirect([m]);
  if (!d.ui.length) { console.log(`=== ${m} === no UI files`); continue; }
  const ctx = buildDirectContext(d, m);
  const vocab = { testIds: testIdsFrom(ctx.uiContext) };
  const schema = extractFormSchema(ctx.uiContext);
  const a = auditCodeTestIds({ schema, vocab, action: 'create' });
  console.log(`=== ${m} ===  testIds in source: ${vocab.testIds.length} | audit ok: ${a.ok}`);
  console.log(`    create=${a.createTestId}  save=${a.saveTestId}`);
  for (const x of a.missing) console.log('    MISSING:', x.message);
  if (ctx.truncated.length) console.log('    truncated:', ctx.truncated.map(t=>`${t.file.split('/').pop()} ${t.keptChars}/${t.totalChars}`).join(', '));
}
