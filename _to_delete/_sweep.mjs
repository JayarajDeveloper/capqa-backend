import { readSourceDirect, buildDirectContext } from './src/lib/rag/discovery.js';
import { extractModuleCapabilities } from './src/lib/rag/codeSignals.js';
import { extractFormSchema } from './src/lib/rag/formSchema.js';
const mods = ['currency','vat','partner','eco-tax','retail-chain','article'];
let okCaps = 0, totFields = 0, totCode = 0, n = 0;
for (const m of mods) {
  const d = await readSourceDirect([m]);
  if (!d.ui.length) continue;
  const ctx = buildDirectContext(d, m);
  const c = extractModuleCapabilities(ctx.uiContext);
  const s = extractFormSchema(ctx.uiContext);
  n++; if (c.listHasEdit) okCaps++;
  totFields += (s.fields||[]).length;
  totCode += ctx.codeContext.length;
}
console.log(`  perFile=${process.env.CAPQA_PER_FILE_CHARS} layer=${process.env.CAPQA_LAYER_CONTEXT_CHARS} code=${process.env.CAPQA_CONTEXT_CHARS}  ->  caps ok ${okCaps}/${n}, total fields ${totFields}, avg codeContext ${Math.round(totCode/n)} chars (~${Math.round(totCode/n/4)} tok)`);
