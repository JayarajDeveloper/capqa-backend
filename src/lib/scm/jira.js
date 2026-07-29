// Server-side Jira Cloud client (REST v3 + Agile v1).
const basic = (email, token) => 'Basic ' + Buffer.from(`${email}:${token}`).toString('base64');

async function call(base, email, token, apiPath, { params, method = 'GET', body } = {}) {
  const url = new URL(base.replace(/\/+$/, '') + apiPath);
  if (params) Object.entries(params).forEach(([k, v]) => v != null && url.searchParams.set(k, v));
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: basic(email, token),
      Accept: 'application/json',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    const err = new Error(`Jira ${res.status}: ${txt.slice(0, 160) || res.statusText}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}
const jiraFetch = (base, email, token, path, opts) => call(base, email, token, '/rest/api/3' + path, opts);
const agileFetch = (base, email, token, path, opts) => call(base, email, token, '/rest/agile/1.0' + path, opts);

const PRIORITY_MAP = { Highest: 'Critical', High: 'High', Medium: 'Medium', Low: 'Low', Lowest: 'Low' };

function adfToText(node) {
  if (!node) return '';
  if (typeof node === 'string') return node;
  if (node.text) return node.text;
  const kids = node.content || [];
  const sep = ['paragraph', 'heading', 'listItem'].includes(node.type) ? '\n' : '';
  return kids.map(adfToText).join('') + sep;
}

export async function verifyAccount(base, email, token) {
  const me = await jiraFetch(base, email, token, '/myself');
  return { accountId: me.accountId, name: me.displayName };
}

/* ---- Filter option sources -------------------------------------------- */

export async function listProjects(base, email, token) {
  const data = await jiraFetch(base, email, token, '/project/search', { params: { maxResults: 100 } });
  return (data.values || []).map((p) => ({ key: p.key, name: p.name }));
}

export async function listIssueTypes(base, email, token) {
  const types = await jiraFetch(base, email, token, '/issuetype');
  const seen = new Set();
  const out = [];
  for (const t of types) {
    if (!seen.has(t.name)) { seen.add(t.name); out.push({ name: t.name, subtask: !!t.subtask }); }
  }
  return out;
}

export async function listStatuses(base, email, token) {
  const statuses = await jiraFetch(base, email, token, '/status');
  const seen = new Set();
  const out = [];
  for (const s of statuses) if (!seen.has(s.name)) { seen.add(s.name); out.push(s.name); }
  return out.slice(0, 60);
}

export async function listBoards(base, email, token, projectKeyOrId) {
  try {
    const data = await agileFetch(base, email, token, '/board', { params: { maxResults: 50, ...(projectKeyOrId ? { projectKeyOrId } : {}) } });
    return (data.values || []).map((b) => ({ id: b.id, name: b.name, type: b.type }));
  } catch { return []; } // Agile API may be unavailable (not Jira Software)
}

export async function listSprints(base, email, token, boardId) {
  try {
    const data = await agileFetch(base, email, token, `/board/${boardId}/sprint`, { params: { maxResults: 50, state: 'active,future,closed' } });
    return (data.values || []).map((s) => ({ id: s.id, name: s.name, state: s.state }));
  } catch { return []; }
}

export async function listEpics(base, email, token, boardId) {
  try {
    const data = await agileFetch(base, email, token, `/board/${boardId}/epic`, { params: { maxResults: 50 } });
    return (data.values || []).map((e) => ({ key: e.key, name: e.name || e.summary || e.key, done: e.done }));
  } catch { return []; }
}

/* ---- JQL builder + issue search --------------------------------------- */

const quote = (v) => `"${String(v).replace(/"/g, '\\"')}"`;

export function buildJql({ project, types, sprintId, epicKey, status, text } = {}) {
  const clauses = [];
  if (project) clauses.push(`project = ${quote(project)}`);
  if (Array.isArray(types) && types.length) clauses.push(`issuetype in (${types.map(quote).join(', ')})`);
  if (sprintId) clauses.push(`sprint = ${sprintId}`);
  if (epicKey) clauses.push(`("Epic Link" = ${quote(epicKey)} OR parent = ${quote(epicKey)})`);
  if (status) clauses.push(`status = ${quote(status)}`);
  if (text) clauses.push(`summary ~ ${quote(text + '*')}`);
  return (clauses.length ? clauses.join(' AND ') + ' ' : '') + 'ORDER BY updated DESC';
}

export async function searchIssues(base, email, token, jql, max = 50) {
  // New enhanced-search endpoint (the old GET /search was removed in Jira Cloud).
  const data = await jiraFetch(base, email, token, '/search/jql', {
    method: 'POST',
    body: {
      jql: jql || 'ORDER BY updated DESC',
      maxResults: max,
      fields: ['summary', 'description', 'priority', 'status', 'issuetype', 'assignee', 'parent', 'updated'],
    },
  });
  return (data.issues || []).map((it) => ({
    id: it.key,
    type: it.fields.issuetype?.name || 'Story',
    isSubtask: !!it.fields.issuetype?.subtask,
    priority: PRIORITY_MAP[it.fields.priority?.name] || it.fields.priority?.name || 'Medium',
    status: it.fields.status?.name || 'To Do',
    statusCategory: it.fields.status?.statusCategory?.key || 'new',
    assignee: it.fields.assignee?.displayName || 'Unassigned',
    parentKey: it.fields.parent?.key || null,
    parentSummary: it.fields.parent?.fields?.summary || null,
    updated: it.fields.updated || null,
    title: it.fields.summary || '',
    description: adfToText(it.fields.description).trim() || '(no description)',
  }));
}
