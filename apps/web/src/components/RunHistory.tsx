import { useEffect, useState } from 'react';
import { fetchCapabilityRuns } from '../api';
import type { CapabilityRun } from '../types';

interface Props {
  capabilityId?: string;
}

export function RunHistory({ capabilityId }: Props) {
  const [runs, setRuns] = useState<CapabilityRun[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      setLoading(true);
      try {
        const res = await fetchCapabilityRuns(capabilityId);
        if (!cancelled) setRuns(res.runs);
      } catch {
        if (!cancelled) setRuns([]);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [capabilityId]);

  if (loading) return <p className="muted">Loading run history…</p>;
  if (runs.length === 0) {
    return <p className="muted">No runs recorded yet.</p>;
  }

  return (
    <div className="stack">
      {runs.map((run) => (
        <article key={run.id} className="card compact">
          <header className="card-header">
            <h4>{run.capability_name}</h4>
            <span className={`badge ${run.status === 'success' ? 'success' : ''}`}>{run.status}</span>
          </header>
          <p className="muted small">{new Date(run.finished_at).toLocaleString()}</p>
          {Array.isArray(run.task_results) && run.task_results.length > 0 && (
            <ol className="checkpoint-list">
              {run.task_results.map((task, idx) => {
                const t = task as { taskId?: string; goal?: string; status?: string; message?: string };
                return (
                  <li key={t.taskId ?? idx} className={t.status}>
                    <span className="checkpoint-action">{t.goal ?? t.taskId}</span>
                    <span className="checkpoint-message">{t.status} — {t.message}</span>
                  </li>
                );
              })}
            </ol>
          )}
          {run.error_message && <p className="muted small">{run.error_message}</p>}
        </article>
      ))}
    </div>
  );
}
