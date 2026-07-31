/**
 * Agentic Reasoning Loop — multi-turn LLM with tool calling.
 *
 * The agent:
 *  1. Receives the user ask + available tools
 *  2. Calls DeepSeek with tool definitions
 *  3. DeepSeek responds with text AND/OR tool_calls
 *  4. Agent executes tool calls, feeds results back
 *  5. Repeats until the agent calls finalize() or hits max turns
 */

import { retrieveChunks, formatChunksForPrompt, layerOf } from '../rag/retrieve.js';
import { parseIntent } from '../rag/ground.js';
import { extractBusinessRules, formatBusinessRulesForPrompt } from '../rag/businessRules.js';
import { extractFormSchema, buildFormFillStepLines } from '../rag/formSchema.js';
import { suggestIndexedFeatures, pickFeatureFromCatalog } from '../rag/ground.js';
import { extractCodeVocabulary, entityStemFromVocab } from '../rag/ground.js';
import { prepareModuleTestCase } from '../rag/testCasePipeline.js';
import { generateComposeArtifacts } from '../llm.js';
import { saveAndRunPlaywrightSpec, writePlaywrightSpec } from '../automation/specWriter.js';
import { buildAutomationBundle } from '../automation/codegen.js';
import { env } from '../../env.js';
import { prisma } from '../../db.js';
import { browserExplore, closeBrowser } from './browserExplorer.js';

const MAX_TURNS = 12;
const TOOL_TIMEOUT_MS = 30000;

// ── DeepSeek call with tool support ────────────────────────────

async function callAgentLLM({ messages, tools, apiKey }) {
  const model = env.DEEPSEEK_MODEL;
  const key = apiKey || env.DEEPSEEK_API_KEY;
  const base = env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com/v1';

  const body = {
    model,
    max_tokens: 4096,
    temperature: 0.1,
    messages,
  };

  if (tools?.length) {
    body.tools = tools;
    body.tool_choice = 'auto';
  }

  const res = await fetch(`${base}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${key}`,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(60000),
  });

  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`DeepSeek ${res.status}: ${t.slice(0, 300)}`);
  }

  return res.json();
}

// ── Tool Executors ──────────────────────────────────────────────

let agentState = {
  projectId: null,
  apiKey: null,
  chunks: [],
  businessRulesText: '',
  formSchema: null,
  matchedFeature: null,
  intent: null,
  automation: null,
  specFile: null,
  cases: [],
  runResult: null,
};

async function executeTool(name, args) {
  const s = agentState;
  switch (name) {
    case 'search_codebase': {
      const chunks = await retrieveChunks({
        projectId: s.projectId,
        query: args.query,
        topK: args.topK || 12,
        apiKey: s.apiKey,
        layers: args.layers?.length ? args.layers : null,
      });
      s.chunks = chunks;
      const summary = chunks.length
        ? `Found ${chunks.length} code chunks:\n${chunks.map(c => `- ${c.path}:${c.startLine}-${c.endLine} (${c.layer || layerOf(c.path)})`).join('\n')}`
        : 'No matching code found in the index.';
      return summary;
    }

    case 'extract_business_rules': {
      const backendChunks = s.chunks.filter(c => {
        const l = c.layer || layerOf(c.path);
        return l === 'backend' || l === 'database';
      });
      if (!backendChunks.length) return 'No backend code chunks available. Search the codebase first with layers=["backend","database"].';
      const catalog = await extractBusinessRules(backendChunks);
      s.businessRulesText = catalog ? formatBusinessRulesForPrompt(catalog, args.entity) : '';
      return s.businessRulesText || 'No business rules extracted from the available backend code.';
    }

    case 'analyze_form_schema': {
      const uiChunks = s.chunks.filter(c => (c.layer || layerOf(c.path)) === 'ui');
      if (!uiChunks.length) return 'No UI code chunks available. Search the codebase first with layers=["ui"].';
      const vocab = extractCodeVocabulary(uiChunks.map(c => c.content).join('\n'));
      const entityStem = entityStemFromVocab(vocab);
      const schema = extractFormSchema(uiChunks.map(c => c.content).join('\n'), { entityStem });
      s.formSchema = schema;
      const fields = (schema.fields || []).map(f =>
        `- ${f.key} (testId: ${f.testId || 'none'}, type: ${f.type || 'text'}, required: ${!!f.required})`
      ).join('\n');
      return `Form schema for ${args.feature}:\n${fields || 'No form fields extracted.'}\nTestIds: ${(vocab.testIds || []).join(', ') || 'none'}\nRoutes: ${(vocab.routes || []).join(', ') || 'none'}`;
    }

    case 'match_feature': {
      const catalog = await suggestIndexedFeatures(s.projectId, ['ui', 'backend'], 20, args.ask).catch(() => []);
      const pick = pickFeatureFromCatalog(args.ask, catalog);
      if (pick.ok) {
        s.matchedFeature = pick.matchedFeature;
        return `Matched: ${pick.matchedFeature} (confidence: ${(pick.confidence * 100).toFixed(0)}%). Search the codebase now for "${pick.matchedFeature}" to load its code.`;
      }
      if (pick.needsClarification) {
        const options = (pick.candidates || catalog).slice(0, 8).map(c => c.name).join(', ');
        return `Ambiguous. Candidates: ${options}. Pick one and set matchedFeature, then search its code.`;
      }
      return `No match found. Try a broader search. Available features: ${catalog.slice(0, 10).map(c => c.name).join(', ')}`;
    }

    case 'generate_tests': {
      if (!s.matchedFeature) return 'Error: No feature matched. Call match_feature first.';
      const intent = s.intent || parseIntent(args.title || '', args.description || '') || { action: 'create' };
      s.intent = intent;

      const codeContext = formatChunksForPrompt(s.chunks.slice(0, 28));
      const uiChunks = s.chunks.filter(c => (c.layer || layerOf(c.path)) === 'ui');
      const apiChunks = s.chunks.filter(c => {
        const l = c.layer || layerOf(c.path);
        return l === 'backend' || l === 'database';
      });
      const uiContext = uiChunks.length ? formatChunksForPrompt(uiChunks.slice(0, 20)) : '';
      const apiContext = apiChunks.length ? formatChunksForPrompt(apiChunks.slice(0, 16)) : '';

      try {
        const result = await generateComposeArtifacts({
          apiKey: s.apiKey,
          title: args.title || '',
          description: args.description || '',
          options: { layers: ['ui', 'backend'], codeOnly: true },
          codeContext,
          uiContext,
          apiContext,
          matchedFeature: s.matchedFeature,
          intent,
          businessRules: s.businessRulesText,
        });

        s.cases = result.cases || [];
        const uiPlan = result.uiPlan;

        // Build automation
        const automation = buildAutomationBundle({
          layers: ['ui', 'backend'],
          uiPlan,
          uiContext,
          apiContext,
          cases: result.cases,
          matchedFeature: s.matchedFeature,
          intent: result.intent || intent,
          uiAutomation: result.uiAutomation,
        });

        if (automation.ui?.steps?.length) {
          const written = await writePlaywrightSpec(automation.ui, {
            title: uiPlan?.title || args.title,
            matchedFeature: s.matchedFeature,
            action: automation.ui.action || intent.action,
          });
          s.automation = automation;
          s.specFile = written.relativePath;
        }

        const caseList = (s.cases || []).map(c => `- [${c.type || '?'}] ${c.title}`).join('\n');
        return `Generated ${s.cases.length} test cases:\n${caseList}\nSpec: ${s.specFile || 'no UI spec'}\nCall finalize() when ready to wrap up.`;
      } catch (e) {
        return `Generation failed: ${e.message}. Check that the API key is valid and code context is sufficient.`;
      }
    }

    case 'write_and_run_spec': {
      if (!s.automation?.ui?.steps?.length) return 'No spec to run. Call generate_tests first.';
      if (args.passed === false) {
        return `Spec written to ${s.specFile}. Dry run — not executing.`;
      }
      try {
        const result = await saveAndRunPlaywrightSpec(s.automation.ui, {
          headless: true,
          runMode: 'background',
          timeoutMs: 120000,
          title: s.automation.ui.title,
          matchedFeature: s.matchedFeature,
          action: s.automation.ui.action,
        });
        s.runResult = result;
        const status = result.passed ? 'PASSED' : 'FAILED';
        const steps = (result.runSteps || []).map(step =>
          `  ${step.status === 'pass' ? '✓' : step.status === 'fail' ? '✗' : '·'} ${step.title}`
        ).join('\n');
        return `${status} — ${result.runSummary?.passed || 0}/${result.runSummary?.total || 0} steps\n${steps}\n${result.log?.split('\n').slice(-5).join('\n') || ''}`;
      } catch (e) {
        return `Run failed: ${e.message}`;
      }
    }

    case 'browser_explore': {
      try {
        const result = await browserExplore(args.flow || []);
        return JSON.stringify(result.slice(0, 3)); // Return first 3 steps to avoid token explosion
      } catch (e) {
        return `Browser explore error: ${e.message}`;
      }
    }

    case 'finalize': {
      return `FINAL|${JSON.stringify({
        summary: args.summary,
        coverage: args.coverage,
        casesGenerated: args.casesGenerated,
        specFile: s.specFile,
        runResult: s.runResult ? { passed: s.runResult.passed } : null,
      })}`;
    }

    default:
      return `Unknown tool: ${name}`;
  }
}

// ── Main Agent Loop ─────────────────────────────────────────────

export async function runAgentLoop({ projectId, title, description, apiKey }) {
  agentState = {
    projectId,
    apiKey,
    chunks: [],
    businessRulesText: '',
    formSchema: null,
    matchedFeature: null,
    intent: null,
    automation: null,
    specFile: null,
    cases: [],
    runResult: null,
  };

  const messages = [
    {
      role: 'system',
      content: `You are Cap QA, an autonomous AI test engineer. Your goal: generate comprehensive Playwright tests by deeply analyzing the codebase.

PROJECT CONTEXT:
- Project ID: ${projectId}
- Target app: ${(await loadTargetUrl(projectId)) || 'not configured'}

CAPABILITIES: You have tools to search the codebase, extract business rules, analyze forms, match features, generate tests, and run specs.

WORKFLOW:
1. Call match_feature to find what the user is asking about
2. Call search_codebase to load code for that feature
3. Call extract_business_rules to get backend constraints
4. Call analyze_form_schema to get frontend form details
5. Call generate_tests to create the test cases
6. Call finalize with your summary

RULES:
- NEVER skip steps — collect code before generating
- Every test must reference actual code, never invent
- Generate negative/boundary tests for every constraint found
- Call finalize() when done`,
    },
    {
      role: 'user',
      content: `Generate comprehensive QA tests for: "${title || ''}"\n${description ? `Details: ${description}` : ''}\n\nStart by matching the feature, then search code, extract rules, generate tests, and finalize.`,
    },
  ];

  const toolDefs = [
    {
      type: 'function',
      function: {
        name: 'match_feature',
        description: 'Find which indexed feature matches the user ask',
        parameters: { type: 'object', properties: { ask: { type: 'string' } }, required: ['ask'] },
      },
    },
    {
      type: 'function',
      function: {
        name: 'search_codebase',
        description: 'Search the codebase index for code chunks',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string' },
            topK: { type: 'integer', default: 12 },
            layers: { type: 'array', items: { type: 'string', enum: ['ui', 'backend', 'database'] } },
          },
          required: ['query'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'extract_business_rules',
        description: 'Extract business rules from backend code',
        parameters: { type: 'object', properties: { entity: { type: 'string' } }, required: ['entity'] },
      },
    },
    {
      type: 'function',
      function: {
        name: 'analyze_form_schema',
        description: 'Extract Angular form schema from UI code',
        parameters: { type: 'object', properties: { feature: { type: 'string' } }, required: ['feature'] },
      },
    },
    {
      type: 'function',
      function: {
        name: 'generate_tests',
        description: 'Generate test cases from code and business rules',
        parameters: {
          type: 'object',
          properties: {
            feature: { type: 'string' },
            action: { type: 'string', enum: ['create', 'update', 'delete', 'list', 'exercise'] },
            title: { type: 'string' },
            description: { type: 'string' },
            codeContext: { type: 'string' },
            uiContext: { type: 'string' },
            apiContext: { type: 'string' },
            businessRules: { type: 'string' },
          },
          required: ['feature'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'browser_explore',
        description: 'Explore the live CapBO app to verify selectors. Navigate to routes, click elements, take snapshots to discover real testIds and DOM structure.',
        parameters: {
          type: 'object',
          properties: {
            flow: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  action: { type: 'string', enum: ['navigate', 'click', 'type', 'snapshot', 'testids'] },
                  url: { type: 'string', description: 'Route to navigate to, e.g. /partners' },
                  testId: { type: 'string', description: 'data-testid to click or type into' },
                  text: { type: 'string', description: 'Text to type into a field' },
                },
                required: ['action'],
              },
            },
          },
          required: ['flow'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'finalize',
        description: 'Return the final result to the user',
        parameters: {
          type: 'object',
          properties: {
            summary: { type: 'string' },
            coverage: { type: 'string' },
            casesGenerated: { type: 'integer' },
          },
          required: ['summary', 'casesGenerated'],
        },
      },
    },
  ];

  let turnCount = 0;
  let finalResult = null;

  while (turnCount < MAX_TURNS && !finalResult) {
    turnCount++;
    console.log(`[agent] turn ${turnCount}`);

    const response = await callAgentLLM({
      messages,
      tools: toolDefs,
      apiKey,
    });

    const choice = response.choices?.[0];
    if (!choice) throw new Error('No response from DeepSeek');

    const msg = choice.message;

    // Add assistant response to history
    messages.push({
      role: 'assistant',
      content: msg.content || null,
      tool_calls: msg.tool_calls || undefined,
    });

    // If the model just returns text without tool calls, we're done
    if (!msg.tool_calls?.length && !finalResult) {
      // Model might return text. Check if it's a final answer.
      if (msg.content) {
        finalResult = {
          summary: msg.content.slice(0, 500),
          coverage: 'See generated cases below',
          casesGenerated: agentState.cases.length || 0,
          specFile: agentState.specFile,
          cases: agentState.cases,
          automation: agentState.automation,
          runResult: agentState.runResult,
        };
        break;
      }
      break;
    }

    // Execute each tool call
    for (const tc of (msg.tool_calls || [])) {
      const fn = tc.function;
      let args = {};
      try { args = JSON.parse(fn.arguments || '{}'); } catch {}

      console.log(`[agent] tool: ${fn.name}(${JSON.stringify(args).slice(0, 120)})`);

      let result;
      try {
        result = await Promise.race([
          executeTool(fn.name, args),
          new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), TOOL_TIMEOUT_MS)),
        ]);
      } catch (e) {
        result = `Tool ${fn.name} error: ${e.message}`;
      }

      // Check for finalize signal
      if (typeof result === 'string' && result.startsWith('FINAL|')) {
        try {
          finalResult = JSON.parse(result.slice(6));
        } catch {
          finalResult = { summary: result.slice(6), casesGenerated: agentState.cases.length };
        }
      }

      messages.push({
        role: 'tool',
        tool_call_id: tc.id,
        content: typeof result === 'string' ? result : JSON.stringify(result),
      });
    }
  }

  if (!finalResult) {
    finalResult = {
      summary: `Agent completed ${turnCount} turns. Generated ${agentState.cases.length} cases.`,
      coverage: 'Partial — agent did not call finalize()',
      casesGenerated: agentState.cases.length,
      specFile: agentState.specFile,
      cases: agentState.cases,
      automation: agentState.automation,
      runResult: agentState.runResult,
    };
  }

  return {
    ...finalResult,
    turns: turnCount,
    agentSteps: buildAgentSteps(agentState, turnCount),
  };
}

function buildAgentSteps(state, turns) {
  return [
    { id: 'match', status: state.matchedFeature ? 'done' : 'pending', label: 'Match feature', detail: state.matchedFeature || 'Waiting…' },
    { id: 'search', status: state.chunks.length ? 'done' : 'pending', label: 'Search codebase', detail: state.chunks.length ? `${state.chunks.length} chunks found` : 'Waiting…' },
    { id: 'rules', status: state.businessRulesText ? 'done' : 'pending', label: 'Extract business rules', detail: state.businessRulesText ? 'Rules extracted' : 'Waiting…' },
    { id: 'schema', status: state.formSchema ? 'done' : 'pending', label: 'Analyze form schema', detail: state.formSchema ? `${state.formSchema.fields?.length || 0} fields` : 'Waiting…' },
    { id: 'generate', status: state.cases.length ? 'done' : 'pending', label: 'Generate tests', detail: state.cases.length ? `${state.cases.length} cases` : 'Waiting…' },
    { id: 'done', status: state.cases.length ? 'done' : 'pending', label: `${state.cases.length} test cases ready`, detail: `${turns} agent turns` },
  ];
}

async function loadTargetUrl(projectId) {
  try {
    const t = await prisma.testTarget.findUnique({ where: { projectId } });
    return t?.appUrl || env.TARGET_APP_URL || null;
  } catch {
    return null;
  }
}
