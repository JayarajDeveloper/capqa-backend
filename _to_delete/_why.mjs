import { readSourceDirect, buildDirectContext } from '../src/lib/rag/discovery.js';
import { isListChunkPath } from '../src/lib/rag/codeSignals.js';
const re = /\[(\d+)\]\s+[^:]+::\s+([\w./-]+):(\d+)-(\d+)\n```[\w]*\n([\s\S]*?)```/g;
for (const m of process.argv.slice(2)) {
  const d = await readSourceDirect([m]);
  const ctx = buildDirectContext(d, m);
  const chunks = [...ctx.uiContext.matchAll(re)].map(x => ({ path: x[2], content: x[5] }));
  const listHtml = chunks.filter(c => isListChunkPath(c.path) && /\.html$/i.test(c.path)).map(c => c.content).join('\n');
  console.log(`=== ${m} ===  ui chunks=${chunks.length}  listHtml=${listHtml.length} chars`);
  console.log('   list paths:', chunks.filter(c=>isListChunkPath(c.path)).map(c=>c.path.split('/').pop()).join(', ') || '(none)');
  console.log('   real testid -edit  :', /data-testid="[^"]*-edit"/i.test(listHtml));
  console.log('   CapBO fallback hit :', (listHtml.match(/edit-btn|editRetail|editPartner|editCurrency/i)||['no'])[0]);
  console.log('   view fallback hit  :', (listHtml.match(/view-btn|viewRetail|viewPartner/i)||['no'])[0]);
}
