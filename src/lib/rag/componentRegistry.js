/**
 * Form component discovery + Playwright strategies — driven by indexed HTML/TS.
 * New wrapper components (app-*-dropdown, etc.) are adopted automatically when they
 * expose [control]="…" and optional testId / data-testid attributes.
 */

/** Map TS control variable → form field key (partnerTypeControl → partnerType). */
export function parseControlBindings(ts = '') {
  const map = {};
  for (const m of String(ts).matchAll(
    /get\s+(\w+)\(\)[^{]*\{\s*return\s+this\.\w+\.get\(['"]([\w]+)['"]\)/g,
  )) {
    map[m[1]] = m[2];
  }
  for (const m of String(ts).matchAll(
    /(\w+Control)\s*=\s*new FormControl[^;]*;\s*(?:\/\/[^\n]*)?\s*(?:\/\*\*[^*]*\*\/\s*)?/g,
  )) {
    const varName = m[1];
    if (!map[varName]) {
      map[varName] = varName.replace(/Control$/, '').replace(/^selected/, '');
    }
  }
  return map;
}

/**
 * Standalone FormControl ↔ FormGroup field sync from TS (valueChanges → .get('field')).
 * Example: fooCodeControl.valueChanges … barForm.get('code') → { fooCodeControl: 'code' }
 *
 * Prefer `this.*Form.get('field')` so autocomplete filters that later mention
 * FormArray keys (e.g. conversionCurrency) do not steal the mapping.
 */
export function parseStandaloneSyncMap(ts = '') {
  const map = {};
  const text = String(ts);

  // Best: valueChanges → this.xxxForm.get('field')
  for (const m of text.matchAll(
    /this\.(\w+Control)\.valueChanges[\s\S]{0,900}?this\.\w*(?:Form|form)\.get\(\s*['"](\w+)['"]\s*\)/g,
  )) {
    if (!map[m[1]]) map[m[1]] = m[2];
  }

  // Fallback: valueChanges → .get('field') only when field is a suffix of the control name
  // (currencyCodeControl → code), never a random later FormArray key.
  for (const m of text.matchAll(
    /this\.(\w+Control)\.valueChanges[\s\S]{0,500}?\.get\(\s*['"](\w+)['"]\s*\)/g,
  )) {
    if (map[m[1]]) continue;
    const control = m[1];
    const field = m[2];
    const stripped = control.replace(/Control$/i, '').replace(/^selected/i, '');
    if (
      stripped.toLowerCase() === field.toLowerCase()
      || stripped.toLowerCase().endsWith(field.toLowerCase())
    ) {
      map[control] = field;
    }
  }

  for (const m of text.matchAll(
    /\.get\(\s*['"](\w+)['"]\s*\)[\s\S]{0,400}?this\.(\w+Control)\.setValue/g,
  )) {
    if (!map[m[2]]) map[m[2]] = m[1];
  }
  return map;
}

/** FormGroup field keys declared in this.fb.group({ … }). */
export function parseFormGroupFieldKeys(ts = '') {
  const keys = new Set();
  for (const m of String(ts).matchAll(
    /(?:this\.)?\w*(?:Form|form)\s*[:=][^=]*fb\.group\(\s*\{([\s\S]*?)\n\s*\}\)/g,
  )) {
    for (const km of m[1].matchAll(/^\s*(\w+)\s*:/gm)) keys.add(km[1]);
  }
  // Fallback: loose formControlName-style keys next to Validators in group
  for (const m of String(ts).matchAll(/\b(\w+)\s*:\s*\[[^\]]*Validators\./g)) {
    keys.add(m[1]);
  }
  return [...keys];
}

/**
 * Resolve a control variable to the FormGroup field it represents.
 * Priority: getter/sync map → suffix match against form fields → strip Control.
 */
export function resolveControlVarToFieldKey(varName, controlMap = {}, formFieldKeys = []) {
  if (!varName) return null;

  if (controlMap[varName] && formFieldKeys.includes(controlMap[varName])) {
    return controlMap[varName];
  }
  if (controlMap[varName] && !formFieldKeys.length) {
    return refineAliasAgainstFormFields(controlMap[varName], formFieldKeys) || controlMap[varName];
  }

  let stripped = varName;
  if (/Control$/.test(varName)) stripped = varName.replace(/Control$/, '');
  if (/^selected/i.test(stripped)) stripped = stripped.replace(/^selected/i, '');

  const refined = refineAliasAgainstFormFields(stripped, formFieldKeys);
  if (refined) return refined;
  if (controlMap[varName]) {
    return refineAliasAgainstFormFields(controlMap[varName], formFieldKeys) || controlMap[varName];
  }
  return stripped || varName;
}

/** Alias like fooCode + form keys [code,name] → code (longest suffix match on a real form field). */
function refineAliasAgainstFormFields(alias, formFieldKeys = []) {
  if (!alias) return null;
  if (formFieldKeys.includes(alias)) return alias;
  if (!formFieldKeys.length) return null;
  const lower = String(alias).toLowerCase();
  const hits = formFieldKeys
    .filter((k) => k.length >= 2 && lower !== k.toLowerCase() && lower.endsWith(k.toLowerCase()))
    .sort((a, b) => b.length - a.length);
  return hits[0] || null;
}

function inferKeyFromControlVar(varName, controlMap, formFieldKeys = []) {
  return resolveControlVarToFieldKey(varName, controlMap, formFieldKeys);
}

function attrFromBlock(block, name) {
  if (name === '[control]') return block.match(/\[control\]="(\w+)"/)?.[1] || null;
  const re = new RegExp(`\\b${name}\\s*=\\s*"([^"]+)"`, 'i');
  return block.match(re)?.[1] || null;
}

function isCustomElementTag(tag) {
  return /^[a-z][\w-]*-[\w-]+$/i.test(String(tag || ''));
}

function inferInnerTag(block, wrapperTag, html) {
  if (/<mat-select/i.test(block)) return 'mat-select';
  if (/mat-autocomplete/i.test(block)) return 'input';
  const region = html.slice(
    Math.max(0, html.indexOf(`<${wrapperTag}`)),
    html.indexOf(`<${wrapperTag}`) + 800,
  );
  if (/<mat-select/i.test(region)) return 'mat-select';
  if (/mat-autocomplete/i.test(region)) return 'input';
  return 'mat-select';
}

function inferWrapperComponentType(wrapperTag, block) {
  const tag = String(wrapperTag || '').toLowerCase();
  if (/autocomplete/i.test(tag) || /mat-autocomplete/i.test(block)) return 'autocomplete';
  if (tag.startsWith('app-')) return tag.slice(4);
  return tag;
}

/** Parse any custom wrapper with [control] binding from HTML (multiline-safe). */
export function parseWrapperDropdownFields(html, {
  controlMap = {},
  formFieldKeys = [],
  validators = {},
  labels = {},
} = {}) {
  const fields = [];
  if (!html) return fields;

  const re = /<([a-z][\w-]*)([\s\S]*?)>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const wrapperTag = m[1].toLowerCase();
    const block = m[2];
    if (!isCustomElementTag(wrapperTag)) continue;
    const controlVar = attrFromBlock(block, '[control]');
    if (!controlVar) continue;

    const key = inferKeyFromControlVar(controlVar, controlMap, formFieldKeys);
    if (!key) continue;

    const testId = attrFromBlock(block, 'testId')
      || attrFromBlock(block, 'data-testid')
      || null;
    const innerTag = inferInnerTag(block, wrapperTag, html);
    const componentType = inferWrapperComponentType(wrapperTag, block);
    const isDropdown = innerTag === 'mat-select' || /dropdown|select/i.test(componentType);

    fields.push({
      key,
      type: isDropdown ? 'dropdown' : componentType,
      componentType,
      wrapperTag,
      innerTag,
      testId,
      label: labels[key] || key,
      validators: validators[key] || {},
      required: Boolean(validators[key]?.required),
      controlVar,
    });
  }
  return fields;
}

function fieldKeyToSlug(key) {
  return String(key)
    .replace(/_/g, '-')
    .replace(/([A-Z])/g, '-$1')
    .toLowerCase()
    .replace(/^-/, '');
}

/** Playwright locator strategies — only from parsed field metadata (testId, wrapperTag, innerTag). */
export function buildSelectStrategies(field) {
  const key = field.key || field.formControl;
  const testId = field.testId;
  const wrapper = field.wrapperTag;
  const innerTag = field.innerTag || 'mat-select';
  const strategies = [];

  if (testId) {
    strategies.push({ type: 'testid', value: testId });
    strategies.push({ type: 'css', value: `[data-testid="${testId}"]` });
    strategies.push({ type: 'css', value: `[data-testid="${testId}"] ${innerTag}` });
  }

  if (wrapper && testId) {
    strategies.push({ type: 'css', value: `${wrapper} [data-testid="${testId}"]` });
    strategies.push({ type: 'css', value: `${wrapper} [data-testid="${testId}"] ${innerTag}` });
    strategies.push({ type: 'css', value: `app-custom-dropdown[data-testid="${testId}"] ${innerTag}` });
    if (wrapper === 'app-countries-dropdown') {
      strategies.push({ type: 'css', value: `app-countries-dropdown [data-testid="${testId}"]` });
    }
  }

  // Secondary form-control attrs only when code already provided testId
  if (testId && wrapper && key) {
    strategies.push({ type: 'css', value: `${wrapper}[data-formcontrolname="${key}"]` });
    strategies.push({ type: 'css', value: `${wrapper}[data-formcontrolname="${key}"] ${innerTag}` });
  }

  if (testId && key) {
    strategies.push({ type: 'css', value: `[data-formcontrolname="${key}"]` });
    strategies.push({ type: 'css', value: `[data-formcontrolname="${key}"] ${innerTag}` });
  }

  return strategies;
}

/** Playwright fill strategies — testId from code, then formControlName on same field key. */
export function buildFillStrategies(field) {
  const key = field.key || field.formControl;
  const testId = field.testId;
  const typ = field.componentType || field.type || '';
  const strategies = [];

  if (testId) {
    strategies.push(
      { type: 'testid', value: testId },
      { type: 'css', value: `[data-testid="${testId}"]` },
      { type: 'css', value: `[data-testid="${testId}"] input, [data-testid="${testId}"] textarea` },
    );
  }

  // formControlName only as secondary locator when code already gave a testId
  if (testId && key && !field.standalone) {
    strategies.push(
      { type: 'css', value: `[formcontrolname="${key}"]` },
      { type: 'css', value: `input[formControlName="${key}"], textarea[formControlName="${key}"]` },
    );
  }

  return strategies;
}

/** Infer component meta from HTML context around a formControlName. */
export function inferNativeFieldMeta(html, key, index) {
  const line = html.slice(Math.max(0, index - 120), index + 160);
  if (/<mat-select/i.test(line)) {
    return { type: 'dropdown', componentType: 'mat-select', wrapperTag: null, innerTag: 'mat-select' };
  }
  if (/mat-autocomplete|matAutocomplete/i.test(line)) {
    return { type: 'autocomplete', componentType: 'autocomplete', wrapperTag: null, innerTag: 'input' };
  }
  if (/mat-slide-toggle/i.test(line)) {
    return { type: 'toggle', componentType: 'mat-slide-toggle', wrapperTag: null, innerTag: null };
  }
  if (/mat-checkbox/i.test(line)) {
    return { type: 'checkbox', componentType: 'mat-checkbox', wrapperTag: null, innerTag: null };
  }
  if (/type="email"/i.test(line)) return { type: 'email', componentType: 'mat-input', wrapperTag: null, innerTag: 'input' };
  if (/type="tel"/i.test(line)) return { type: 'phone', componentType: 'mat-input', wrapperTag: null, innerTag: 'input' };
  if (/type="number"/i.test(line)) return { type: 'number', componentType: 'mat-input', wrapperTag: null, innerTag: 'input' };
  if (/appLocalizedDecimalInput|inputmode="decimal"/i.test(line)) {
    return { type: 'decimal', componentType: 'mat-input', wrapperTag: null, innerTag: 'input' };
  }
  return { type: 'text', componentType: 'mat-input', wrapperTag: null, innerTag: 'input' };
}

/** Whether automation should interact with this field on create flows. */
export function isAutomatableField(field) {
  if (!field) return false;
  if (field.componentType === 'mat-slide-toggle') return false;
  if (field.componentType === 'mat-checkbox') return false;
  if (field.type === 'toggle' || field.type === 'checkbox') return false;
  // Edit-only FormArray rows (currency conversions) — not on create
  const key = String(field.key || '');
  if (/conversionCurrency|quoteCurrency/i.test(key)) return false;
  if (/^validFrom$|^validTo$/i.test(key)) return false;
  return true;
}

/** Interaction kind for runner: select | fill | skip */
export function interactionKindForField(field, value) {
  if (!isAutomatableField(field)) return 'skip';
  const ct = String(field.componentType || '');
  const typ = String(field.type || '');
  if (
    typ === 'dropdown'
    || ct === 'dropdown'
    || /dropdown|select|mat-select/i.test(ct)
    || /dropdown|select/i.test(typ)
    || value === '__first__'
  ) {
    return 'select';
  }
  if (typ === 'autocomplete' || ct === 'autocomplete') return 'fill';
  if (typ === 'toggle' || typ === 'checkbox') return 'skip';
  if (field.wrapperTag && field.innerTag === 'mat-select') return 'select';
  if (field.wrapperTag && /dropdown|select/i.test(field.wrapperTag)) return 'select';
  return 'fill';
}

/** AI often invents "category-abc12" for dropdowns — treat as first-option intent. */
export function isInventedDropdownValue(value, formControl) {
  if (value == null || value === '' || value === '__first__' || value === 'first') return true;
  const v = String(value).trim();
  const key = String(formControl || '').trim();
  if (!key) return false;
  if (new RegExp(`^${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[-_][a-z0-9]+$`, 'i').test(v)) {
    return true;
  }
  if (/^(select|choose|first|option|dropdown)/i.test(v)) return true;
  return false;
}
