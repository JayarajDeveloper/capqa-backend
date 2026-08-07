/**
 * Agent Tools — functions the AI agent can call during its reasoning loop.
 *
 * Each tool has:
 *  1. A function definition (OpenAI-compatible JSON schema) for the LLM
 *  2. An async handler that executes the tool and returns a result string
 */

import { retrieveChunks, formatChunksForPrompt, layerOf } from '../rag/retrieve.js';
import { suggestIndexedFeatures, parseIntent, pickFeatureFromCatalog, extractCodeVocabulary, entityStemFromVocab } from '../rag/ground.js';
import { extractBusinessRules, formatBusinessRulesForPrompt } from '../rag/businessRules.js';
import { extractFormSchema } from '../rag/formSchema.js';
import { buildAutomationBundle } from '../automation/codegen.js';
import { writePlaywrightSpec, saveAndRunPlaywrightSpec, ensurePlaywrightConfig } from '../automation/specWriter.js';
import { generateComposeArtifacts } from '../llm.js';
import { extractModuleCapabilities, assessComposeFeasibility } from '../rag/codeSignals.js';
import { prepareModuleTestCase } from '../rag/testCasePipeline.js';

// ── Tool Definitions (what the LLM sees) ──────────────────────

export const AGENT_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'search_codebase',
      description: 'Search the indexed codebase (RAG) for relevant code chunks. Use this to find frontend components, backend entities, services, routes, and SQL migrations matching a query.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'What to search for — entity name, feature, concept' },
          topK: { type: 'integer', description: 'Max results (default 12)', default: 12 },
          layers: { type: 'array', items: { type: 'string', enum: ['ui', 'backend', 'database'] }, description: 'Filter by code layer' },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'extract_business_rules',
      description: 'Extract structured business rules (Doctrine constraints, Symfony validators, API permissions, service guards) from backend code chunks for a given entity.',
      parameters: {
        type: 'object',
        properties: {
          entity: { type: 'string', description: 'Entity/feature name, as discovered in the target source' },
        },
        required: ['entity'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'analyze_form_schema',
      description: 'Extract the Angular form schema from UI code — field names, testIds, validators, component types, required fields.',
      parameters: {
        type: 'object',
        properties: {
          feature: { type: 'string', description: 'Feature/module name to analyze forms for' },
        },
        required: ['feature'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'match_feature',
      description: 'Find which indexed feature best matches a user ask. Returns candidates with confidence scores.',
      parameters: {
        type: 'object',
        properties: {
          ask: { type: 'string', description: 'The user free-text ask' },
        },
        required: ['ask'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'generate_tests',
      description: 'Generate test cases (Playwright + manual) from code context and business rules. Call this after collecting enough code and rules.',
      parameters: {
        type: 'object',
        properties: {
          feature: { type: 'string', description: 'Matched feature name' },
          action: { type: 'string', enum: ['create', 'update', 'delete', 'list', 'exercise'], description: 'Test action' },
          title: { type: 'string', description: 'Original user ask title' },
          description: { type: 'string', description: 'Original user ask description' },
          codeContext: { type: 'string', description: 'UI code context (formatted chunks)' },
          uiContext: { type: 'string', description: 'UI-specific code context' },
          apiContext: { type: 'string', description: 'Backend API code context' },
          businessRules: { type: 'string', description: 'Formatted business rule catalog' },
          intent: { type: 'object', description: 'Parsed intent from parseIntent' },
        },
        required: ['feature'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'write_and_run_spec',
      description: 'Write the generated Playwright spec to disk and run it against the target app. Returns test results.',
      parameters: {
        type: 'object',
        properties: {
          passed: { type: 'boolean', description: 'True to run all tests. False to only write/dry-run.' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'finalize',
      description: 'Return the final composed result to the user — includes all test cases, the Playwright spec path, and a coverage summary.',
      parameters: {
        type: 'object',
        properties: {
          summary: { type: 'string', description: 'Summary of what was generated and tested' },
          coverage: { type: 'string', description: 'Business logic coverage percentage and gaps' },
          casesGenerated: { type: 'integer', description: 'Number of test cases generated' },
        },
        required: ['summary', 'casesGenerated'],
      },
    },
  },
];

// ── System Prompt for the Agent ────────────────────────────────

export const AGENT_SYSTEM_PROMPT = `You are Cap QA, an autonomous AI test engineer. Your goal: generate comprehensive Playwright tests from user asks by deeply analyzing the codebase.

CAPABILITIES:
- Search the indexed codebase (frontend + backend + database migrations)
- Extract business rules from Symfony entities, services, and validators
- Analyze Angular form schemas for testIds and field types
- Match user asks to indexed features with confidence scoring
- Generate Playwright specs and run them against the target app

WORKFLOW — follow this order:
1. UNDERSTAND the ask — parse what the user wants
2. SEARCH the codebase for relevant frontend + backend code
3. EXTRACT business rules from the backend (entities, validators, permissions)
4. ANALYZE the frontend form schema (fields, testIds, routes)
5. GENERATE test cases covering happy path + ALL business rule scenarios
6. FINALIZE with a summary of coverage

RULES:
- NEVER invent code, fields, or routes — only use what you find via tools
- Every test case must reference a specific business rule or code constraint
- Generate negative/boundary tests for EVERY constraint you discover
- Call finalize() when done — do not leave the user waiting
- If the codebase has no matches, say so honestly — don't fabricate`;
