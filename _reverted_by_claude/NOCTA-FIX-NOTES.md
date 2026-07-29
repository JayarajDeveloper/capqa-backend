# Nocta QA — why data filling failed for 2 days, and what was fixed

Date: 2026-07-21 · Scope: nocta-backend generation pipeline + generated-e2e specs for the 5 CapBO modules (VAT, Eco Tax, Partners, Currency, Retail Chain).

## The root causes (verified against capbo-frontend source)

**1. The extractor never saw the whole component file — so it never saw all your test-ids.**
Live GitLab hydration truncated every file at 12,000 chars (`live.js MAX_FILE_CHARS`), and index retrieval caps chunks at 2,500 chars. But the schema-critical markup sits far past that: `partner.component.html` is 70,506 chars (`partner-save` at char 57,126), `partner.component.ts` is 136,598 chars (the `fb.group` with `Validators.required` at char 13,972), `eco-tax-details.component.ts` has its validators ~22k chars in. Result: the pipeline randomly missed test-ids and required-field rules depending on what survived truncation — which is exactly why specs sometimes used real test-ids and sometimes fell back to guesses.

**2. Guessed selectors that can never exist in the DOM.**
When a testId was missed, `buildSelectStrategies` fell back to `app-custom-dropdown[data-formcontrolname="enterpriseIdentifierType"]`. Angular never renders a `data-formcontrolname` attribute for `[control]`-bound wrappers — that locator matches nothing, ever → guaranteed timeout (your partners spec died on exactly this line, even though `testId="partner-enterprise-identifier-type"` exists in partner.component.html).

**3. Custom dropdowns treated as text fields.**
`fillAngularField(page.getByTestId("eco-tax-category"), "category-8ectb")` — eco-tax-category is an `app-custom-dropdown` (a mat-form-field containing a `mat-select`, no `<input>` at all). Playwright `fill()` on it throws "not an input". And a typed value like "category-8ectb" is not a real option anyway.

**4. Missing required fields → Save button permanently disabled.**
`eco-tax` requires `vat_id` (`initForm()`: all 7 controls `Validators.required`; save is `[disabled]="ecoTaxForm.invalid"`). The generated spec never selected a VAT because the validators were past the truncation point — so even with every other fill working, Save could never be clicked.

**5. The post-save verification searched a field that isn't there.**
The verify step used `input[formcontrolname="searchTerm"]`. The shared `app-list-filters-card` binds `[formControlName]="searchControlName"` dynamically — dynamic bindings render NO attribute. Only retail-chain (own inline input) matched; eco-tax/vat/partners/currency verifications failed even after successful creation.

**6. Locale decimal inputs.**
`valued` / `rate` / `roundingIncrement` use `appLocalizedDecimalInput` (French: "." → ","). A single programmatic fill can be mangled by the sanitizer; values are now typed key-by-key so the directive does its own conversion.

## What changed

### nocta-backend/src
- `lib/rag/live.js` — component `.html/.ts` files are fetched **whole** (400k cap); only non-component files keep the 12k cap. New export `maxCharsForPath()`.
- `lib/rag/retrieve.js` — new `capChunkBodiesForPrompt()`: the **LLM prompt** gets capped chunk bodies, schema extraction keeps the full text. (Separation of concerns: full files for extraction, bounded prompt for the model.)
- `lib/llm.js` — the three prompt builders now wrap code context with `capChunkBodiesForPrompt`.
- `lib/rag/formSchema.js` — validator parser now also anchors `this.xxxForm = this.fb.group({…})` (eco-tax `initForm()` style) and merges every primary form group, so `vat_id`-class required fields are always known.
- `lib/rag/componentRegistry.js` — **all `data-formcontrolname` strategies removed.** Fallbacks are now real: `[data-testid$="-<slug>"]` convention, then `wrapper mat-select`.
- `lib/automation/codegen.js` — `renderLocatorExpr` refuses unmatchable strategies (stale plans included); verify step now emits `searchList(...)` with the module's search testid when one exists; `searchTestId` is threaded through automation data.
- `lib/automation/aiAutomation.js` — fixed a TDZ crash (`route` computed from `feature` before its declaration) that silently killed AI-authored plans whenever the plan omitted `route`.
- `package.json` — test script now also runs the new regression suite.

### nocta-backend/generated-e2e
- `helpers/capbo-ui.ts` — hardened:
  - `fillAngularField` detects dropdown hosts in the live DOM and delegates to `selectMatDropdown` (self-healing if a plan ever misclassifies again); decimal inputs are typed per-key; fills verify the value landed and retry by typing.
  - `selectMatDropdown` polls up to 12s for async options (staticFetchFn/HTTP), uses the panel search (`ngx-mat-select-search`) for concrete values, verifies the panel closed.
  - new `searchList` — finds the list search box on every module (explicit testid → `*-search` → `.search-field input` → literal `formcontrolname="searchTerm"`), with a goto-route fallback.
- **5 grounded specs, verified line-by-line against capbo-frontend source:**
  - `vat-create.spec.ts` (name, rate, country)
  - `eco-tax-create.spec.ts` (code, name, display_label, valued, **vat** — needs ≥1 VAT record)
  - `partners-create.spec.ts` (code, name, type, **enterprise-identifier-type via its real testid**, currency)
  - `retail-chain-create.spec.ts` (name)
  - `currency-create.spec.ts` (code `[A-Z]{3}`, numericCode `[0-9]{3}`, name, symbol, roundingIncrement — pattern values generated per run)
  - Each asserts **Save is enabled before clicking** — if a required field ever fails again, the test fails right there with a readable message instead of a mystery timeout.

### Tests
- `src/lib/rag/groundedSpec.test.js` (new): for eco-tax/partners/vat with FULL real files — no phantom selectors anywhere, wrapper dropdowns are select-steps with their real testId, every no-default required field reaches the plan, emitted specs use `searchList`.
- `src/lib/rag/extractTestData.test.js`: the assertion that *expected* a `data-formcontrolname` strategy now asserts the opposite (that assertion had codified the bug).
- `npm test` → 3 suites, all passing.

## How to run

```bash
cd nocta-backend

# one-time (or when session expires): headed SSO login, saves generated-e2e/.auth/user.json
E2E_AUTH_SETUP=1 npx playwright test generated-e2e/auth.setup.spec.ts --headed

# the 5 modules
TARGET_APP_URL=... APP_TEST_USERNAME=... APP_TEST_PASSWORD=... \
npx playwright test generated-e2e/vat-create.spec.ts generated-e2e/currency-create.spec.ts \
  generated-e2e/eco-tax-create.spec.ts generated-e2e/partners-create.spec.ts \
  generated-e2e/retail-chain-create.spec.ts --headed
```

Order note: run `vat-create` and `currency-create` before `eco-tax-create` / `partners-create` on an empty database — eco-tax needs an existing VAT, partners needs an existing currency. On your dev data this doesn't matter.

The old timestamped specs (`eco-tax-mru*.spec.ts`, `partners-mru*.spec.ts`, …) are superseded — delete them when convenient, or they'll fail for the documented reasons.

## The "simple logic" you asked for — now the actual behavior

Feature matched → its component files are read **complete** from the live branch → every `data-testid` / `testId` / `Validators.*` is extracted deterministically (no LLM in this step) → the LLM only decides scenario flow and gets the full field catalog (key + testId + type + rules) → codegen emits locators **exclusively** from extracted test-ids, with business-rule test data (`[A-Z]{3}` patterns, min/max decimals, unique suffixes) → helpers absorb runtime realities (async options, locale decimals, Material overlays).
