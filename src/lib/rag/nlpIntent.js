/**
 * NLP Intent Parser — uses DeepSeek to understand free-form user asks
 * with typos, grammar mistakes, mixed languages, and non-standard phrasing.
 *
 * Falls back to keyword-based parseIntent() when DeepSeek is unavailable.
 */

import { env } from '../../env.js';

const NLP_INTENT_PROMPT = `You are an intent parser for a QA testing platform. Extract structured intent from the user's free-text ask.

The user may have typos, grammar mistakes, mixed languages, or non-standard phrasing. Your job is to understand their INTENT, not just their words.

Return ONLY valid JSON — no explanation, no markdown:

{
  "action": "create|update|delete|list|link|assign|view",
  "entities": ["entity names mentioned, correcting any misspellings"],
  "primaryEntity": "the main entity the user is working with",
  "crossModule": true if the ask involves multiple entities that need to be linked,
  "fieldValues": {"field_name": "value extracted from ask"},
  "testName": "a short descriptive test name",
  "notes": ["validation|uniqueness|permission|negative|boundary"],
  "confidence": 0.0-1.0
}

GUIDELINES:
- Correct obvious typos in entity names (e.g. "parnter" → "Partner")
- Detect cross-module asks where one entity links to another
- Extract specific field values when the user provides them (names, codes, types)
- Set confidence lower when the ask is ambiguous`;

/**
 * Parse user intent using DeepSeek NLP.
 * Falls back to keyword parser on failure.
 */
export async function nlpParseIntent(title, description, { apiKey } = {}) {
  const text = [title, description].filter(Boolean).join('\n');
  if (!text.trim()) return null;

  const key = apiKey || env.DEEPSEEK_API_KEY;
  if (!key) return null; // caller falls back to keyword parser

  try {
    const res = await fetch(`${env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com/v1'}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${key}`,
      },
      body: JSON.stringify({
        model: env.DEEPSEEK_MODEL,
        max_tokens: 512,
        temperature: 0,
        messages: [
          { role: 'system', content: NLP_INTENT_PROMPT },
          { role: 'user', content: text },
        ],
      }),
      signal: AbortSignal.timeout(10000),
    });

    if (!res.ok) return null;

    const data = await res.json();
    const raw = data.choices?.[0]?.message?.content || '';
    
    // Extract JSON from response
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;
    
    const parsed = JSON.parse(jsonMatch[0]);
    
    return {
      action: parsed.action || 'exercise',
      entities: parsed.entities || [],
      primaryEntity: parsed.primaryEntity || parsed.entities?.[0] || '',
      crossModule: !!parsed.crossModule,
      fieldValues: parsed.fieldValues || {},
      testName: parsed.testName || title || '',
      notes: parsed.notes || [],
      confidence: parsed.confidence || 0.5,
      // Keep backward compat fields
      subjectTerms: parsed.entities || [],
      expandedTerms: parsed.entities || [],
      summary: parsed.testName || text.slice(0, 120),
      rawTitle: title || '',
      rawDescription: description || '',
      combinedAsk: text,
      searchQuery: [parsed.primaryEntity, ...(parsed.entities || [])].filter(Boolean).join(' '),
      actionScores: { [parsed.action || 'exercise']: 1 },
      isNlpParsed: true,
    };
  } catch (e) {
    console.warn('[nlp] intent parse failed:', e.message);
    return null;
  }
}

/**
 * Merge NLP intent with keyword-parsed intent for best coverage.
 */
export function mergeIntents(nlpIntent, keywordIntent) {
  if (!nlpIntent) return keywordIntent;
  if (!keywordIntent) return nlpIntent;

  // NLP wins for action and entities
  // Keyword wins for subject terms (index-compatible terms)
  return {
    ...keywordIntent,
    action: nlpIntent.action,
    entities: nlpIntent.entities,
    primaryEntity: nlpIntent.primaryEntity,
    crossModule: nlpIntent.crossModule,
    fieldValues: nlpIntent.fieldValues,
    notes: [...new Set([...(nlpIntent.notes || []), ...(keywordIntent.notes || [])])],
    testName: nlpIntent.testName || keywordIntent.summary,
    isNlpParsed: true,
  };
}
