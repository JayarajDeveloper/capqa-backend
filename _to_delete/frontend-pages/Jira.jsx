import { useCallback, useEffect, useState } from 'react';
import { api } from '../api.js';
import { useProject } from '../project.jsx';
import { Badge, Empty, Loading, priorityColor } from '../components/ui.jsx';

function typeColor(t) {
  const k = (t || '').toLowerCase();
  if (k.includes('bug')) return 'red';
  if (k.includes('sub')) return 'gray';
  if (k.includes('story')) return 'green';
  if (k.includes('epic')) return 'violet';
  if (k.includes('task')) return 'blue';
  return 'gray';
}
function statusColor(cat) {
  return { done: 'green', indeterminate: 'amber', new: 'gray' }[cat] || 'gray';
}

export default function Jira({ go, setComposeTicket }) {
  const { activeProject } = useProject();
  const pid = activeProject?.id;

  const [conn, setConn] = useState(undefined); // undefined=loading, null=none
  const [meta, setMeta] = useState({ projects: [], issueTypes: [], statuses: [] });
  const [boards, setBoards] = useState([]);
  const [sprints, setSprints] = useState([]);
  const [epics, setEpics] = useState([]);

  const [f, setF] = useState({ project: '', boardId: '', types: [], sprintId: '', epicKey: '', status: '', text: '' });
  const [issues, setIssues] = useState([]);
  const [jql, setJql] = useState('');
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState('');

  // Find the Jira connector for this project.
  useEffect(() => {
    let alive = true;
    (async () => {
      if (!pid) return;
      try {
        const cs = await api.connectors.list(pid);
        if (alive) setConn(cs.find((c) => c.provider === 'JIRA') || null);
      } catch { if (alive) setConn(null); }
    })();
    return () => { alive = false; };
  }, [pid]);

  // Load filter metadata once connected.
  useEffect(() => {
    if (!conn) return;
    (async () => {
      try { setMeta(await api.jira.meta(pid, conn.id)); }
      catch (e) { setErr(String(e.message || e)); }
    })();
  }, [conn, pid]);

  // When a project is chosen, load its boards.
  useEffect(() => {
    if (!conn || !f.project) { setBoards([]); return; }
    (async () => { try { setBoards(await api.jira.boards(pid, conn.id, f.project)); } catch { setBoards([]); } })();
  }, [conn, pid, f.project]);

  // When a board is chosen, load sprints + epics.
  useEffect(() => {
    if (!conn || !f.boardId) { setSprints([]); setEpics([]); return; }
    (async () => {
      try {
        const [s, e] = await Promise.all([api.jira.sprints(pid, conn.id, f.boardId), api.jira.epics(pid, conn.id, f.boardId)]);
        setSprints(s); setEpics(e);
      } catch { setSprints([]); setEpics([]); }
    })();
  }, [conn, pid, f.boardId]);

  const search = useCallback(async () => {
    if (!conn) return;
    setLoading(true); setErr('');
    try {
      const res = await api.jira.issues(pid, conn.id, {
        project: f.project, types: f.types.join(','), sprintId: f.sprintId, epicKey: f.epicKey, status: f.status, text: f.text, max: 100,
      });
      setIssues(res.issues); setJql(res.jql);
    } catch (e) { setErr(String(e.message || e)); }
    finally { setLoading(false); }
  }, [conn, pid, f]);

  // Auto-search when structured filters change (not text — that's on Enter/button).
  useEffect(() => { if (conn) search(); /* eslint-disable-next-line */ }, [conn, f.project, f.types, f.sprintId, f.epicKey, f.status]);

  const toggleType = (t) => setF((p) => ({ ...p, types: p.types.includes(t) ? p.types.filter((x) => x !== t) : [...p.types, t] }));
  const useTicket = (it) => { setComposeTicket({ id: it.id, title: it.title, description: it.description }); go('compose'); };

  if (conn === undefined) return <div className="page"><Loading label="Loading Jira…" /></div>;
  if (conn === null) {
    return (
      <div className="page fade-in">
        <div className="card">
          <Empty icon="🗂" title="Jira isn't connected for this project"
            sub="Connect Jira from the Connectors tab, then come back to browse tickets." />
          <div style={{ textAlign: 'center', paddingBottom: 24 }}>
            <button className="btn primary" onClick={() => go('connectors')}>🔌 Open Connectors</button>
          </div>
        </div>
      </div>
    );
  }

  const commonTypes = ['Bug', 'Task', 'Sub-task', 'Story', 'Epic'];
  const availableTypes = meta.issueTypes.length
    ? [...new Set([...commonTypes.filter((t) => meta.issueTypes.some((x) => x.name.toLowerCase() === t.toLowerCase())), ...meta.issueTypes.map((x) => x.name)])]
    : commonTypes;

  return (
    <div className="page fade-in">
      <div className="flex between center wrap gap8">
        <div className="provider-pill"><span className="dot live" /> {conn.baseUrl.replace(/^https?:\/\//, '')} · {conn.accountName}</div>
        <div className="faint" style={{ fontSize: 12 }}>{issues.length} tickets</div>
      </div>

      {/* Filters */}
      <div className="card card-pad mt16">
        <div className="flex gap12 wrap">
          <div style={{ flex: '1 1 180px' }}>
            <label className="field">Project</label>
            <select value={f.project} onChange={(e) => setF({ ...f, project: e.target.value, boardId: '', sprintId: '', epicKey: '' })}>
              <option value="">All projects</option>
              {meta.projects.map((p) => <option key={p.key} value={p.key}>{p.key} · {p.name}</option>)}
            </select>
          </div>
          <div style={{ flex: '1 1 180px' }}>
            <label className="field">Board</label>
            <select value={f.boardId} disabled={!boards.length} onChange={(e) => setF({ ...f, boardId: e.target.value, sprintId: '', epicKey: '' })}>
              <option value="">{boards.length ? 'Select board' : 'No boards'}</option>
              {boards.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
            </select>
          </div>
          <div style={{ flex: '1 1 180px' }}>
            <label className="field">Sprint</label>
            <select value={f.sprintId} disabled={!sprints.length} onChange={(e) => setF({ ...f, sprintId: e.target.value })}>
              <option value="">{sprints.length ? 'All sprints' : 'No sprints'}</option>
              {sprints.map((s) => <option key={s.id} value={s.id}>{s.name} {s.state ? `(${s.state})` : ''}</option>)}
            </select>
          </div>
          <div style={{ flex: '1 1 180px' }}>
            <label className="field">Epic</label>
            <select value={f.epicKey} disabled={!epics.length} onChange={(e) => setF({ ...f, epicKey: e.target.value })}>
              <option value="">{epics.length ? 'All epics' : 'No epics'}</option>
              {epics.map((e) => <option key={e.key} value={e.key}>{e.name}</option>)}
            </select>
          </div>
          <div style={{ flex: '1 1 180px' }}>
            <label className="field">Status</label>
            <select value={f.status} onChange={(e) => setF({ ...f, status: e.target.value })}>
              <option value="">Any status</option>
              {meta.statuses.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
          </div>
        </div>

        <label className="field" style={{ marginTop: 14 }}>Type</label>
        <div className="pill-row">
          {availableTypes.map((t) => (
            <span key={t} className="chip" onClick={() => toggleType(t)}
              style={{ cursor: 'pointer', background: f.types.includes(t) ? 'var(--accent)' : 'var(--bg-3)', color: f.types.includes(t) ? '#fff' : 'var(--text-dim)' }}>
              {f.types.includes(t) ? '✓ ' : ''}{t}
            </span>
          ))}
        </div>

        <div className="flex gap8 mt16">
          <input value={f.text} onChange={(e) => setF({ ...f, text: e.target.value })} onKeyDown={(e) => e.key === 'Enter' && search()} placeholder="Search summary…" />
          <button className="btn primary" disabled={loading} onClick={search}>{loading ? <span className="spinner" /> : 'Search'}</button>
        </div>
        {jql && <div className="faint mono mt8" style={{ fontSize: 11 }}>JQL: {jql}</div>}
        {err && <div style={{ color: 'var(--red)', fontSize: 12.5, marginTop: 10 }}>{err}</div>}
      </div>

      {/* Results */}
      <div className="card mt16">
        {loading ? <Loading label="Fetching tickets…" /> : issues.length === 0 ? (
          <Empty icon="🎫" title="No tickets match" sub="Adjust the filters above." />
        ) : (
          <table>
            <thead><tr><th>Key</th><th>Type</th><th>Summary</th><th>Status</th><th>Priority</th><th>Assignee</th><th></th></tr></thead>
            <tbody>
              {issues.map((it) => (
                <tr key={it.id}>
                  <td className="mono faint">{it.id}</td>
                  <td><Badge color={typeColor(it.type)}>{it.type}</Badge></td>
                  <td>
                    <div style={{ fontWeight: 550 }}>{it.title}</div>
                    {it.parentKey && <div className="faint" style={{ fontSize: 11.5 }}>↳ {it.parentKey} {it.parentSummary || ''}</div>}
                  </td>
                  <td><Badge color={statusColor(it.statusCategory)}>{it.status}</Badge></td>
                  <td><Badge color={priorityColor(it.priority)}>{it.priority}</Badge></td>
                  <td className="faint" style={{ fontSize: 12.5 }}>{it.assignee}</td>
                  <td><button className="btn sm primary" onClick={() => useTicket(it)}>Compose →</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
