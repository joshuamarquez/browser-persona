import { useState } from 'react';
import type { Pattern } from '../types';
import { labelPattern, reprocessPipeline, runPipeline } from '../api';
import { formatSteps } from '../utils';
import { ReplayModal } from './ReplayModal';

interface Props {
  patterns: Pattern[];
  onUpdated: () => void;
}

export function Patterns({ patterns, onUpdated }: Props) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pipelineMsg, setPipelineMsg] = useState<string | null>(null);
  const [replayWorkflowId, setReplayWorkflowId] = useState<string | null>(null);

  async function handleLabel(patternId: string) {
    setBusy(patternId);
    setError(null);
    try {
      await labelPattern(patternId);
      onUpdated();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Labeling failed');
    } finally {
      setBusy(null);
    }
  }

  async function handlePipeline() {
    setBusy('pipeline');
    setError(null);
    setPipelineMsg(null);
    try {
      const result = await runPipeline();
      const mergeMsg =
        result.llmMergePairsJudged != null
          ? `, LLM merge ${result.llmMergePairsMerged}/${result.llmMergePairsJudged}`
          : '';
      setPipelineMsg(
        `Closed ${result.sessionsClosed}, segmented ${result.sessionsSegmented}, ` +
          `workflows ${result.workflowsCreated}, patterns ${result.patternsFound}${mergeMsg}`,
      );
      onUpdated();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Pipeline failed');
    } finally {
      setBusy(null);
    }
  }

  async function handleReprocess() {
    setBusy('reprocess');
    setError(null);
    setPipelineMsg(null);
    try {
      const result = await reprocessPipeline();
      const mergeMsg =
        result.llmMergePairsJudged != null
          ? `, LLM merge ${result.llmMergePairsMerged}/${result.llmMergePairsJudged}`
          : '';
      setPipelineMsg(
        `Reprocessed ${result.sessionsSegmented} sessions, ` +
          `workflows ${result.workflowsCreated}, patterns ${result.patternsFound}${mergeMsg}`,
      );
      onUpdated();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Reprocess failed');
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="stack">
      <div className="toolbar">
        <button type="button" disabled={busy === 'pipeline'} onClick={handlePipeline}>
          Run pipeline
        </button>
        <button type="button" disabled={busy === 'reprocess'} onClick={handleReprocess}>
          Reprocess all
        </button>
        <span className="muted">
          Pipeline runs automatically after tab close (~5s); use Refresh to load new patterns
        </span>
      </div>

      {pipelineMsg && <div className="banner success">{pipelineMsg}</div>}
      {error && <div className="banner error">{error}</div>}

      {patterns.length === 0 ? (
        <div className="empty">
          <p>No patterns mined yet.</p>
          <p className="muted">
            Record the same workflow 3+ times (close the tab each time). The pipeline runs on the
            API automatically — click Refresh when you are ready to check for patterns.
          </p>
        </div>
      ) : (
        patterns.map((p) => (
          <article key={p.id} className="card compact">
            <header className="card-header">
              <div>
                <div className="eyebrow mono">
                  {p.fingerprint.length > 80 ? `${p.fingerprint.slice(0, 80)}…` : p.fingerprint}
                </div>
                <h2>{p.occurrence_count} occurrences</h2>
              </div>
              <div className="badges">
                {p.has_approved_capability && <span className="badge success">Approved</span>}
                {p.has_pending_proposal && <span className="badge warn">In inbox</span>}
              </div>
            </header>

            <p className="steps">{formatSteps(p.step_template)}</p>
            <p className="muted">Domains: {p.domains.join(', ') || '—'}</p>

            <div className="actions">
              {p.example_workflow_id && (
                <button type="button" onClick={() => setReplayWorkflowId(p.example_workflow_id)}>
                  View replay
                </button>
              )}
              {!p.has_pending_proposal && !p.has_approved_capability && (
                <button
                  type="button"
                  className="primary"
                  disabled={busy === p.id}
                  onClick={() => handleLabel(p.id)}
                >
                  Generate label
                </button>
              )}
            </div>
          </article>
        ))
      )}

      {replayWorkflowId && (
        <ReplayModal
          workflowId={replayWorkflowId}
          title="Pattern example replay"
          onClose={() => setReplayWorkflowId(null)}
        />
      )}
    </div>
  );
}
