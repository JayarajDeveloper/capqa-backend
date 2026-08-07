import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { useProject } from '../project.jsx';
import { Badge, Empty, Loading } from '../components/ui.jsx';
import { RunLog } from '../components/RunLog.jsx';

function statusColor(s) {
  if (s === 'passed' || s === 'pass') return 'green';
  if (s === 'failed' || s === 'fail') return 'red';
  if (s === 'skipped' || s === 'pending') return 'gray';
  return 'amber';
}

function ArtifactPlayer({ art }) {
  const [src, setSrc] = useState(null);
  const [err, setErr] = useState('');

  useEffect(() => {
    let revoked = null;
    let cancelled = false;
    (async () => {
      try {
        const url = await api.reports.fetchArtifact(art.url);
        if (cancelled) {
          URL.revokeObjectURL(url);
          return;
        }
        revoked = url;
        setSrc(url);
      } catch (e) {
        if (!cancelled) setErr(String(e.message || e));
      }
    })();
    return () => {
      cancelled = true;
      if (revoked) URL.revokeObjectURL(revoked);
    };
  }, [art.url]);

  if (err) return <div className="faint" style={{ fontSize: 12 }}>{err}</div>;
  if (!src) return <Loading label="Loading artifact…" />;

  if (art.type === 'video') {
    return (
      <video className="report-video" controls src={src} />
    );
  }
  if (art.type === 'screenshot') {
    return <img className="report-shot" src={src} alt={art.fileName} />;
  }
  return (
    <a className="btn sm" href={src} download={art.fileName}>
      Download {art.type} · {art.fileName}
    </a>
  );
}

function ReportDetail({ report, onBack }) {
  const videos = (report.artifacts || []).filter((a) => a.type === 'video');
  const shots = (report.artifacts || []).filter((a) => a.type === 'screenshot');
  const traces = (report.artifacts || []).filter((a) => a.type === 'trace');
  const acs = report.acResults || [];

  return (
    <div className="fade-in">
      <div className="flex between center wrap gap8" style={{ marginBottom: 14 }}>
        <button type="button" className="btn sm ghost" onClick={onBack}>← All reports</button>
        <Badge color={statusColor(report.status)}>{report.status}</Badge>
      </div>

      <div className="card card-pad" style={{ marginBottom: 14 }}>
        <div style={{ fontWeight: 650, fontSize: 16 }}>{report.label}</div>
        <div className="faint" style={{ fontSize: 12.5, marginTop: 6 }}>
          {new Date(report.createdAt).toLocaleString()}
          {report.suite?.name ? ` · Suite: ${report.suite.name}` : ''}
          {report.kind ? ` · ${report.kind}` : ''}
          {report.runMode ? ` · ${report.runMode}` : ''}
          {report.durationMs != null ? ` · ${(report.durationMs / 1000).toFixed(1)}s` : ''}
        </div>
        <div className="flex gap8 wrap" style={{ marginTop: 10 }}>
          <Badge color="green">{report.passed} passed</Badge>
          {report.failed > 0 && <Badge color="red">{report.failed} failed</Badge>}
          {report.skipped > 0 && <Badge color="gray">{report.skipped} skipped</Badge>}
          {report.feature && <Badge color="violet">{report.feature}</Badge>}
        </div>
      </div>

      {acs.length > 0 && (
        <div className="card card-pad" style={{ marginBottom: 14 }}>
          <div style={{ fontWeight: 600, marginBottom: 10 }}>Acceptance criteria</div>
          <div className="ac-list">
            {acs.map((a) => (
              <div key={a.id} className={`ac-item ac-${a.status === 'pass' ? 'pass' : a.status === 'fail' ? 'fail' : 'pending'}`}>
                <div className="ac-req">
                  <span className="ac-id">{a.id}</span>
                  <span className="ac-text">{a.requirement}</span>
                  <span className={`ac-status ${a.status === 'pass' ? 'pass' : a.status === 'fail' ? 'fail' : 'pending'}`}>
                    {a.status}
                  </span>
                </div>
                {a.evidence && (
                  <div className="faint mono" style={{ fontSize: 11.5, marginTop: 4, paddingLeft: 4 }}>
                    {a.evidence}
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {(report.runSteps?.length > 0 || report.log) && (
        <div className="card card-pad" style={{ marginBottom: 14 }}>
          <div style={{ fontWeight: 600, marginBottom: 10 }}>Steps</div>
          <RunLog
            result={{
              passed: report.status === 'passed',
              skipped: report.status === 'skipped',
              runSteps: report.runSteps,
              runSummary: report.runSummary,
              log: report.log,
              durationMs: report.durationMs,
              kind: report.kind,
              runMode: report.runMode,
            }}
          />
        </div>
      )}

      {(videos.length > 0 || shots.length > 0 || traces.length > 0) && (
        <div className="card card-pad" style={{ marginBottom: 14 }}>
          <div style={{ fontWeight: 600, marginBottom: 10 }}>Artifacts</div>
          {videos.map((a) => (
            <div key={a.id} style={{ marginBottom: 12 }}>
              <div className="faint mono" style={{ fontSize: 11, marginBottom: 6 }}>Video · {a.fileName}</div>
              <ArtifactPlayer art={a} />
            </div>
          ))}
          {shots.map((a) => (
            <div key={a.id} style={{ marginBottom: 12 }}>
              <div className="faint mono" style={{ fontSize: 11, marginBottom: 6 }}>Screenshot · {a.fileName}</div>
              <ArtifactPlayer art={a} />
            </div>
          ))}
          {traces.map((a) => (
            <div key={a.id} style={{ marginBottom: 8 }}>
              <ArtifactPlayer art={a} />
            </div>
          ))}
        </div>
      )}

      {Array.isArray(report.childRuns) && report.childRuns.length > 0 && (
        <div className="card card-pad">
          <div style={{ fontWeight: 600, marginBottom: 10 }}>Suite cases</div>
          {report.childRuns.map((c) => (
            <div key={c.id} className="flex between center" style={{ padding: '8px 0', borderBottom: '1px solid var(--border-soft)' }}>
              <span>{c.case?.title || c.label}</span>
              <Badge color={statusColor(c.status)}>{c.status}</Badge>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export default function Reports({ go, openReportId, clearOpenReport }) {
  const { activeProject } = useProject();
  const pid = activeProject?.id;
  const [reports, setReports] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState(null);
  const [filter, setFilter] = useState('all');

  const load = async () => {
    if (!pid) return;
    setLoading(true);
    setError('');
    try {
      const filters = filter === 'all' ? {} : { status: filter };
      const res = await api.reports.list(pid, filters);
      setReports(res.reports || []);
    } catch (e) {
      setError(String(e.message || e));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, [pid, filter]);

  useEffect(() => {
    if (!pid || !openReportId) return;
    (async () => {
      try {
        const res = await api.reports.get(pid, openReportId);
        setSelected(res.report);
        clearOpenReport?.();
      } catch (e) {
        setError(String(e.message || e));
      }
    })();
  }, [pid, openReportId]);

  const openReport = async (id) => {
    try {
      const res = await api.reports.get(pid, id);
      setSelected(res.report);
    } catch (e) {
      setError(String(e.message || e));
    }
  };

  if (selected) {
    return (
      <div className="page">
        <ReportDetail report={selected} onBack={() => { setSelected(null); load(); }} />
      </div>
    );
  }

  return (
    <div className="page fade-in">
      <div className="flex between center wrap gap12" style={{ marginBottom: 14 }}>
        <div className="flex gap8">
          {['all', 'passed', 'failed', 'skipped'].map((f) => (
            <button
              key={f}
              type="button"
              className={`btn sm ${filter === f ? 'primary' : ''}`}
              onClick={() => setFilter(f)}
            >
              {f[0].toUpperCase() + f.slice(1)}
            </button>
          ))}
        </div>
        <button type="button" className="btn sm" onClick={() => go?.('suites')}>Suites →</button>
      </div>

      {loading && <Loading label="Loading reports…" />}
      {error && <div className="card card-pad" style={{ color: 'var(--red)' }}>{error}</div>}

      {!loading && !error && reports.length === 0 && (
        <div className="card">
          <Empty
            icon="📋"
            title="No reports yet"
            sub="Run a compose draft or suite — each execution is saved with AC points and artifacts."
          />
        </div>
      )}

      {!loading && reports.length > 0 && (
        <div className="card card-pad">
          <table>
            <thead>
              <tr>
                <th>When</th>
                <th>Report</th>
                <th>Suite</th>
                <th>Kind</th>
                <th>Result</th>
                <th>AC</th>
                <th>Media</th>
              </tr>
            </thead>
            <tbody>
              {reports.map((r) => {
                const acPass = (r.acResults || []).filter((a) => a.status === 'pass').length;
                const acTotal = (r.acResults || []).length;
                const media = (r.artifacts || []).filter((a) => a.type === 'video' || a.type === 'screenshot').length;
                return (
                  <tr key={r.id} style={{ cursor: 'pointer' }} onClick={() => openReport(r.id)}>
                    <td className="faint">{new Date(r.createdAt).toLocaleString()}</td>
                    <td>{r.label}</td>
                    <td className="faint">{r.suite?.name || '—'}</td>
                    <td><Badge color="violet">{r.kind}</Badge></td>
                    <td><Badge color={statusColor(r.status)}>{r.status}</Badge></td>
                    <td className="faint">{acTotal ? `${acPass}/${acTotal}` : '—'}</td>
                    <td className="faint">{media ? `${media}` : '—'}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
