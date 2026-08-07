import { buildCapabilityIndex, requiredFieldNames, createOperation } from '../src/lib/index/capabilityIndex.js';

// The tables currently hardcoded in codegen.js:1588-1620, verbatim.
const HARDCODED_PATH = {
  ecotax: '/api/ecotaxes', currency: '/api/currencies', vat: '/api/vats',
  partner: '/api/partners', 'retail-chain': '/api/retail-chains', article: '/api/articles',
};
const HARDCODED_REQUIRED = {
  ecotax: ['code','name','display_label','category','calculation_mode','value','vat_id'],
  currency: ['code','numericCode','name','symbol','roundingIncrement'],
  vat: ['code','name','rate'], partner: ['code','name'],
  'retail-chain': ['code','name'], article: ['code','shortDesignation'],
};

const idx = await buildCapabilityIndex({ apiRoot: process.env.CAPQA_LOCAL_API_ROOT });
console.log(`modules indexed: ${Object.keys(idx.modules).length}\n`);

let pathOk = 0, pathBad = 0;
console.log('=== API COLLECTION PATH: hardcoded vs derived ===');
for (const [m, want] of Object.entries(HARDCODED_PATH)) {
  const mod = idx.modules[m];
  const got = mod?.api?.collectionPath ?? null;
  const ok = got === want;
  ok ? pathOk++ : pathBad++;
  console.log(`  ${ok ? 'OK  ' : 'DIFF'} ${m.padEnd(13)} want ${String(want).padEnd(22)} got ${String(got).padEnd(22)} ${mod?.api?.source || ''}`);
}

console.log('\n=== REQUIRED FIELDS: hardcoded vs derived ===');
for (const [m, want] of Object.entries(HARDCODED_REQUIRED)) {
  const mod = idx.modules[m];
  const got = requiredFieldNames(mod, { wire: true });
  const missing = want.filter((w) => !got.includes(w));
  const extra = got.filter((g) => !want.includes(g));
  console.log(`  ${missing.length ? 'GAP ' : 'OK  '} ${m.padEnd(13)} derived=[${got.join(',')}]`);
  if (missing.length) console.log(`       missing vs hardcoded: ${missing.join(', ')}`);
  if (extra.length)   console.log(`       extra (not hardcoded): ${extra.join(', ')}`);
}

console.log('\n=== CREATE OPERATION (derived, no table) ===');
for (const m of Object.keys(HARDCODED_PATH)) {
  const op = createOperation(idx.modules[m]);
  console.log(`  ${m.padEnd(13)} ${op ? `${op.methods.join('/')} ${op.path}   ${op.source}` : '(none found)'}`);
}
console.log(`\nPATH: ${pathOk} match, ${pathBad} differ`);
