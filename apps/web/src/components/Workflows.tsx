import { useEffect, useState } from 'react';
import type { IntentWorkflowSummary } from '../types';
import { fetchIntentWorkflows, reprocessPipeline, runPipeline } from '../api';
import { ReplayModal } from './ReplayModal';

function formatPipelineStats(result: Record<string, unknown>): string {
  const intentMsg =
    result.intentsExtracted != null
      ? `, intents ${result.intentsExtracted}` +
        (result.intentsDeduped ? ` (${result.intentsDeduped} deduped)` : '') +
        (result.intentsAutoApproved ? ` (${result.intentsAutoApproved} auto-approved)` : '')
      : '';
  const retentionMsg =
    result.rrwebPurged != null && Number(result.rrwebPurged) > 0
      ? `, rrweb purged ${result.rrwebPurged}`
      : '';
  return (
    `Closed ${result.sessionsClosed}, segmented ${result.sessionsSegmented}, ` +
    `workflows ${result.workflowsCreated}${intentMsg}${retentionMsg}`
  );
}

export function Workflows() {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pipelineMsg, setPipelineMsg] = useState<string | null>(null);
  const [replayWorkflowId, setReplayWorkflowId] = useState<string | null>(null);
  const [intentWorkflows, setIntentWorkflows] = useState<IntentWorkflowSummary[]>([]);

  const refreshWorkflows = async () => {
    const intents = await fetchIntentWorkflows();
    setIntentWorkflows(intents.workflows);
  };

  useEffect(() => {
    void refreshWorkflows().catch(() => setIntentWorkflows([]));
  }, []);

  async function handlePipeline() {
    setBusy('pipeline');
    setError(null);
    setPipelineMsg(null);
    try {
      const result = await runPipeline();
      setPipelineMsg(formatPipelineStats(result));
      await refreshWorkflows();
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
      setPipelineMsg(formatPipelineStats(result));
      await refreshWorkflows();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Reprocess failed');
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="stack">
      <div className="toolbar">
        <button type="button" disabled={busy === 'pipeline'} onClick={() => void handlePipeline()}>
          Run pipeline
        </button>
        <button type="button" disabled={busy === 'reprocess'} onClick={() => void handleReprocess()}>
          Reprocess all
        </button>
        <span className="muted">
          Intent workflows are extracted after each journey — review pending items in Inbox.
        </span>
      </div>

      {pipelineMsg && <div className="banner success">{pipelineMsg}</div>}
      {error && <div className="banner error">{error}</div>}

      {intentWorkflows.length === 0 ? (
        <div className="empty">
          <p>No intent workflows yet.</p>
          <p className="muted">
            Record a journey with the extension, close the tab, then run the pipeline. Semantic capture
            mode reduces ingest payload size.
          </p>
        </div>
      ) : (
        intentWorkflows.map((w) => (
          <article key={w.id} className="card compact">
            <header className="card-header">
              <div>
                <div className="eyebrow mono">{w.primary_domain}</div>
                <h3>{new Date(w.created_at).toLocaleString()}</h3>
              </div>
              <div className="badges">
                {w.linked_capability_id && (
                  <span className="badge success">Linked to capability</span>
                )}
                {w.has_pending_proposal && <span className="badge warn">In inbox</span>}
              </div>
            </header>
            <div className="actions">
              <button type="button" onClick={() => setReplayWorkflowId(w.id)}>
                View replay
              </button>
            </div>
          </article>
        ))
      )}

      {replayWorkflowId && (
        <ReplayModal
          workflowId={replayWorkflowId}
          title="Workflow replay"
          onClose={() => setReplayWorkflowId(null)}
        />
      )}
    </div>
  );
}
