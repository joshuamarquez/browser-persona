import { useEffect, useState } from 'react';
import { fetchCapability, runCapability } from '../api';
import type { Capability, RunCapabilityResult, WorkflowParameter } from '../types';

interface Props {
  capability: Capability;
  onClose: () => void;
}

export function RunCapabilityModal({ capability, onClose }: Props) {
  const [parameters, setParameters] = useState<WorkflowParameter[]>([]);
  const [values, setValues] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<RunCapabilityResult | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      setLoading(true);
      setError(null);
      try {
        const { capability: detail } = await fetchCapability(capability.id);
        if (cancelled) return;
        const params = detail.parameters ?? [];
        setParameters(params);
        const initial: Record<string, string> = {};
        for (const p of params) {
          if (p.example) initial[p.name] = p.example;
        }
        setValues(initial);
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Failed to load capability');
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [capability.id]);

  const handleRun = async () => {
    setRunning(true);
    setError(null);
    setResult(null);
    try {
      const payload = Object.fromEntries(
        Object.entries(values).filter(([, value]) => value.trim() !== ''),
      );
      const runResult = await runCapability(capability.id, payload);
      setResult(runResult);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Run failed');
    } finally {
      setRunning(false);
    }
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal run-modal" onClick={(e) => e.stopPropagation()}>
        <header className="modal-header">
          <h3>Run capability</h3>
          <button type="button" className="ghost" onClick={onClose}>
            Close
          </button>
        </header>

        <p className="muted">{capability.name}</p>
        <p className="muted small">
          Runs on the API host with per-step validation checkpoints. For a visible browser while using
          Docker, run <code>npm run docker:exec</code> instead of the containerized API.
        </p>

        {loading ? (
          <p className="muted">Loading parameters…</p>
        ) : (
          <>
            {parameters.length > 0 && (
              <div className="param-grid">
                {parameters.map((param) => (
                  <label key={param.name}>
                    {param.name}
                    <input
                      value={values[param.name] ?? ''}
                      onChange={(e) =>
                        setValues((prev) => ({ ...prev, [param.name]: e.target.value }))
                      }
                      placeholder={param.example ?? param.type}
                    />
                  </label>
                ))}
              </div>
            )}

            <div className="actions">
              <button
                type="button"
                className="primary"
                onClick={() => void handleRun()}
                disabled={running}
              >
                {running ? 'Running…' : 'Run headful'}
              </button>
            </div>
          </>
        )}

        {error && <div className="banner error">{error}</div>}

        {result && (
          <div className="run-results">
            <div className={`banner ${result.success ? 'success' : 'error'}`}>
              {result.success ? 'All checkpoints passed.' : `Failed at step ${(result.failedAt ?? 0) + 1}.`}
            </div>
            <ol className="checkpoint-list">
              {result.checkpoints.map((checkpoint) => (
                <li key={checkpoint.stepIndex} className={checkpoint.status}>
                  <span className="checkpoint-action">
                    {checkpoint.stepIndex + 1}. {checkpoint.action}
                  </span>
                  <span className="checkpoint-message">{checkpoint.message}</span>
                </li>
              ))}
            </ol>
            {result.repair && (
              <details className="reasoning">
                <summary>LLM repair suggestion ({Math.round(result.repair.confidence * 100)}%)</summary>
                <p>{result.repair.diagnosis}</p>
                <p className="muted">{result.repair.reasoning}</p>
                {result.repair.suggested_step_patch && (
                  <pre className="code-block">
                    {JSON.stringify(result.repair.suggested_step_patch, null, 2)}
                  </pre>
                )}
              </details>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
