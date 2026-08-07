import { useEffect, useMemo, useState } from 'react';
import { api } from '../api.js';
import { useProject } from '../project.jsx';
import { Badge, Empty, Loading } from '../components/ui.jsx';

const RUN_MODE_KEY = 'capqa_suite_run_mode';

function loadRunMode() {
  try {
    return localStorage.getItem(RUN_MODE_KEY) === 'foreground' ? 'foreground' : 'background';
  } catch {
    return 'background';
  }
}

function casePayload(c) {
  const auto = c.automation || {};
  const kind = c.kind || 'ui';
  const payload = kind === 'database'
    ? (auto.db || auto)
    : kind === 'api'
      ? (auto.api || auto)
      : (auto.ui || auto);
  return { kind, payload };
}

function CaseRow({
  c,
  suiteId,
  checked,
  onToggle,
  expanded,
  onExpand,
  onRemove,
  onRunOne,
  running,
  runMode,
}) {
  const acs = Array.isArray(c.acceptanceCriteria) ? c.acceptanceCriteria : [];
  const { payload } = casePayload(c);
  const stepCount = payload?.steps?.length || 0;

  return (
    <div className={`suite-case ${expanded ? 'open' : ''}`}>
      <div className="suite-case-head">
        <label className="suite-check" onClick={(e) => e.stopPropagation()}>
          <input type="checkbox" checked={checked} onChange={() => onToggle(c.id)} disabled={running} />
        </label>
        <button type="button" className="suite-case-main" onClick={() => onExpand(c.id)}>
          <span className="suite-chevron">{expanded ? '▾' : '▸'}</span>
          <span className="suite-case-title">{c.title}</span>
          <Badge color="violet">{c.kind || 'ui'}</Badge>
          <span className="faint" style={{ fontSize: 12 }}>
            {acs.length ? `${acs.length} AC` : 'no AC'}
            {stepCount ? ` · ${stepCount} steps` : c.hasAutomation ? ' · automation' : ' · no automation'}
          </span>
        </button>
        <div className="suite-case-actions" onClick={(e) => e.stopPropagation()}>
          <button
            type="button"
            className="btn sm primary"
            disabled={running || !stepCount}
            onClick={() => onRunOne(c)}
            title={`Run this case (${runMode})`}
          >
            ▶ Run
          </button>
          <button type="button" className="btn sm ghost" disabled={running} onClick={() => onRemove(suiteId, c.id)}>
            Remove
          </button>
        </div>
      </div>

      {expanded && (
        <div className="suite-case-detail">
          {(c.askTitle || c.askDescription) && (
            <div className="suite-detail-block">
              <div className="suite-detail-label">Ask</div>
              <div>{c.askTitle || c.title}</div>
              {c.askDescription && <div className="faint" style={{ marginTop: 4, whiteSpace: 'pre-wrap' }}>{c.askDescription}</div>}
            </div>
          )}

          {acs.length > 0 && (
            <div className="suite-detail-block">
              <div className="suite-detail-label">Acceptance criteria · {acs.length}</div>
              <ul className="suite-ac-list">
                {acs.map((a, i) => (
                  <li key={a.id || i}>
                    <span className="mono faint">{a.id || `AC-${i + 1}`}</span>
                    {' '}
                    {a.requirement || String(a)}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {stepCount > 0 ? (
            <div className="suite-detail-block">
              <div className="suite-detail-label">Automation steps · {stepCount}</div>
              <ol className="suite-step-list">
                {payload.steps.slice(0, 12).map((s, i) => (
                  <li key={s.id || i}>
                    <strong>{s.action || s.method || 'step'}</strong>
                    {s.description ? ` — ${s.description}` : s.path ? ` — ${s.path}` : ''}
                  </li>
                ))}
                {payload.steps.length > 12 && (
                  <li className="faint">… +{payload.steps.length - 12} more</li>
                )}
              </ol>
            </div>
          ) : (
            <div className="faint" style={{ fontSize: 13 }}>No runnable automation on this case — recompose and Assign to suite again.</div>
          )}
        </div>
      )}
    </div>
  );
}

export default function Suites({ go }) {
  const { activeProject } = useProject();
  const pid = activeProject?.id;
  const [suites, setSuites] = useState([]);
  const [selected, setSelected] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [name, setName] = useState('');
  const [running, setRunning] = useState(false);
  const [runMsg, setRunMsg] = useState('');
  const [runMode, setRunMode] = useState(loadRunMode);
  const [expandedCaseId, setExpandedCaseId] = useState(null);
  const [selectedCaseIds, setSelectedCaseIds] = useState(() => new Set());
  const [selectedSuiteIds, setSelectedSuiteIds] = useState(() => new Set());

  const setRunModePersisted = (mode) => {
    const next = mode === 'foreground' ? 'foreground' : 'background';
    setRunMode(next);
    try { localStorage.setItem(RUN_MODE_KEY, next); } catch { /* ignore */ }
  };

  const load = async () => {
    if (!pid) return;
    setLoading(true);
    setError('');
    try {
      const res = await api.suites.list(pid);
      setSuites(res.suites || []);
    } catch (e) {
      setError(String(e.message || e));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, [pid]);

  const createSuite = async () => {
    if (!name.trim()) return;
    try {
      await api.suites.create(pid, { name: name.trim() });
      setName('');
      await load();
    } catch (e) {
      setError(String(e.message || e));
    }
  };

  const openSuite = async (id) => {
    try {
      const res = await api.suites.get(pid, id);
      setSelected(res.suite);
      setExpandedCaseId(null);
      setSelectedCaseIds(new Set((res.suite.cases || []).map((c) => c.id)));
      setRunMsg('');
    } catch (e) {
      setError(String(e.message || e));
    }
  };

  const removeSuite = async (id) => {
    if (!confirm('Delete this suite and its cases?')) return;
    await api.suites.remove(pid, id);
    setSelected(null);
    setSelectedSuiteIds((prev) => {
      const n = new Set(prev);
      n.delete(id);
      return n;
    });
    await load();
  };

  const removeCase = async (suiteId, caseId) => {
    await api.suites.removeCase(pid, suiteId, caseId);
    await openSuite(suiteId);
  };

  const runCases = async (suite, cases, label) => {
    if (!cases?.length) {
      setRunMsg('No cases selected');
      return;
    }
    setRunning(true);
    setRunMsg('');
    let passed = 0;
    let failed = 0;
    const headless = runMode !== 'foreground';
    try {
      for (const c of cases) {
        const { kind, payload } = casePayload(c);
        if (!payload?.steps?.length) {
          failed += 1;
          continue;
        }
        const res = await api.ai.runTests(pid, {
          automation: payload,
          kind,
          options: {
            headless,
            runMode,
            suiteId: suite.id,
            caseId: c.id,
            label: `${suite.name} · ${c.title}`,
            askTitle: c.askTitle || c.title,
            acceptanceCriteria: c.acceptanceCriteria || [],
            feature: c.feature,
            recordVideo: runMode === 'foreground' ? 'on' : 'retain-on-failure',
          },
        });
        if (res.passed) passed += 1;
        else failed += 1;
      }
      setRunMsg(`${label} · ${passed} passed · ${failed} failed — open Reports`);
    } catch (e) {
      setRunMsg(String(e.message || e));
    } finally {
      setRunning(false);
    }
  };

  const toggleCase = (id) => {
    setSelectedCaseIds((prev) => {
      const n = new Set(prev);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  };

  const toggleAllCases = () => {
    const all = selected?.cases || [];
    if (selectedCaseIds.size === all.length) setSelectedCaseIds(new Set());
    else setSelectedCaseIds(new Set(all.map((c) => c.id)));
  };

  const toggleSuitePick = (id) => {
    setSelectedSuiteIds((prev) => {
      const n = new Set(prev);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  };

  const casesToRun = useMemo(() => {
    const all = selected?.cases || [];
    return all.filter((c) => selectedCaseIds.has(c.id));
  }, [selected, selectedCaseIds]);

  const runSelectedSuites = async () => {
    const ids = [...selectedSuiteIds];
    if (!ids.length) {
      setRunMsg('Select one or more suites first');
      return;
    }
    setRunning(true);
    setRunMsg('');
    let passed = 0;
    let failed = 0;
    const headless = runMode !== 'foreground';
    try {
      for (const sid of ids) {
        const res = await api.suites.get(pid, sid);
        const suite = res.suite;
        for (const c of suite.cases || []) {
          const { kind, payload } = casePayload(c);
          if (!payload?.steps?.length) {
            failed += 1;
            continue;
          }
          const out = await api.ai.runTests(pid, {
            automation: payload,
            kind,
            options: {
              headless,
              runMode,
              suiteId: suite.id,
              caseId: c.id,
              label: `${suite.name} · ${c.title}`,
              askTitle: c.askTitle || c.title,
              acceptanceCriteria: c.acceptanceCriteria || [],
              feature: c.feature,
              recordVideo: runMode === 'foreground' ? 'on' : 'retain-on-failure',
            },
          });
          if (out.passed) passed += 1;
          else failed += 1;
        }
      }
      setRunMsg(`Multi-suite · ${passed} passed · ${failed} failed — open Reports`);
    } catch (e) {
      setRunMsg(String(e.message || e));
    } finally {
      setRunning(false);
    }
  };

  const ModeSeg = (
    <div className="plan-toolbar-group">
      <span className="plan-toolbar-label">Mode</span>
      <div className="seg">
        <button
          type="button"
          className={`seg-btn ${runMode === 'foreground' ? 'on' : ''}`}
          disabled={running}
          onClick={() => setRunModePersisted('foreground')}
          title="Visible browser for UI cases"
        >
          👁 Foreground
        </button>
        <button
          type="button"
          className={`seg-btn ${runMode === 'background' ? 'on' : ''}`}
          disabled={running}
          onClick={() => setRunModePersisted('background')}
          title="Headless / faster"
        >
          ⚡ Background
        </button>
      </div>
    </div>
  );

  if (selected) {
    const all = selected.cases || [];
    const allChecked = all.length > 0 && selectedCaseIds.size === all.length;

    return (
      <div className="page fade-in">
        <div className="suite-detail-toolbar">
          <button type="button" className="btn sm ghost" disabled={running} onClick={() => { setSelected(null); load(); }}>
            ← Suites
          </button>
          {ModeSeg}
          <div className="suite-detail-actions">
            <button
              type="button"
              className="btn sm"
              disabled={running || !casesToRun.length}
              onClick={() => runCases(selected, casesToRun, `Selected (${casesToRun.length})`)}
            >
              {running ? <><span className="spinner" /> Running…</> : `▶ Run selected (${casesToRun.length})`}
            </button>
            <button
              type="button"
              className="btn primary sm"
              disabled={running || !all.length}
              onClick={() => runCases(selected, all, 'Suite')}
            >
              {running ? <><span className="spinner" /> Running…</> : '▶ Run suite'}
            </button>
            <button type="button" className="btn sm danger" disabled={running} onClick={() => removeSuite(selected.id)}>
              Delete
            </button>
          </div>
        </div>

        <div className="card card-pad" style={{ marginBottom: 14 }}>
          <div style={{ fontWeight: 650, fontSize: 16 }}>{selected.name}</div>
          <div className="faint" style={{ fontSize: 12.5, marginTop: 4 }}>
            {all.length} case(s)
            {selected.feature ? ` · ${selected.feature}` : ''}
            {' · '}
            runs in <b style={{ color: 'var(--text)' }}>{runMode}</b>
          </div>
          {runMsg && (
            <div className="plan-suite-feedback" style={{ marginTop: 10 }}>
              <span>
                {runMsg}{' '}
                {/Reports/i.test(runMsg) && (
                  <button type="button" className="linkish" onClick={() => go?.('reports')}>Open Reports</button>
                )}
              </span>
            </div>
          )}
        </div>

        {all.length === 0 ? (
          <div className="card">
            <Empty icon="📂" title="No cases yet" sub="In NL Compose, pick this suite and click Assign to suite." />
          </div>
        ) : (
          <div className="card card-pad suite-cases-card">
            <div className="suite-cases-toolbar">
              <label className="suite-check">
                <input type="checkbox" checked={allChecked} onChange={toggleAllCases} disabled={running} />
                <span className="faint" style={{ fontSize: 12.5 }}>Select all</span>
              </label>
              <span className="faint" style={{ fontSize: 12.5 }}>
                Click a row to expand AC + steps · Run one or selected
              </span>
            </div>
            {all.map((c) => (
              <CaseRow
                key={c.id}
                c={c}
                suiteId={selected.id}
                checked={selectedCaseIds.has(c.id)}
                onToggle={toggleCase}
                expanded={expandedCaseId === c.id}
                onExpand={(id) => setExpandedCaseId((cur) => (cur === id ? null : id))}
                onRemove={removeCase}
                onRunOne={(caseItem) => runCases(selected, [caseItem], 'Single case')}
                running={running}
                runMode={runMode}
              />
            ))}
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="page fade-in">
      <div className="card card-pad" style={{ marginBottom: 14 }}>
        <div style={{ fontWeight: 600, marginBottom: 8 }}>New suite</div>
        <div className="flex gap8">
          <input
            style={{ flex: 1 }}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Eco tax · regression"
            onKeyDown={(e) => e.key === 'Enter' && createSuite()}
          />
          <button type="button" className="btn primary" onClick={createSuite}>Create</button>
        </div>
      </div>

      <div className="suite-list-toolbar card card-pad" style={{ marginBottom: 14 }}>
        {ModeSeg}
        <button
          type="button"
          className="btn primary sm"
          disabled={running || selectedSuiteIds.size === 0}
          onClick={runSelectedSuites}
        >
          {running
            ? <><span className="spinner" /> Running…</>
            : `▶ Run ${selectedSuiteIds.size || ''} suite${selectedSuiteIds.size === 1 ? '' : 's'}`}
        </button>
        {runMsg && !selected && (
          <span className="faint" style={{ fontSize: 12.5 }}>
            {runMsg}{' '}
            {/Reports/i.test(runMsg) && (
              <button type="button" className="linkish" onClick={() => go?.('reports')}>Open Reports</button>
            )}
          </span>
        )}
      </div>

      {loading && <Loading label="Loading suites…" />}
      {error && <div className="card card-pad" style={{ color: 'var(--red)' }}>{error}</div>}

      {!loading && suites.length === 0 && (
        <div className="card">
          <Empty icon="🗂️" title="No suites yet" sub="Create a suite, then save cases from NL Compose." />
        </div>
      )}

      {!loading && suites.length > 0 && (
        <div className="card card-pad">
          {suites.map((s) => (
            <div key={s.id} className="suite-list-row">
              <label className="suite-check" onClick={(e) => e.stopPropagation()}>
                <input
                  type="checkbox"
                  checked={selectedSuiteIds.has(s.id)}
                  onChange={() => toggleSuitePick(s.id)}
                  disabled={running}
                />
              </label>
              <button type="button" className="suite-list-main" onClick={() => openSuite(s.id)}>
                <div style={{ fontWeight: 600 }}>{s.name}</div>
                <div className="faint" style={{ fontSize: 12.5 }}>
                  {s.caseCount} cases · {s.runCount} runs
                  {s.feature ? ` · ${s.feature}` : ''}
                </div>
              </button>
              <span className="faint suite-list-open">Details →</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
