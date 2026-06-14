import { useEffect, useState } from 'react';
import { fetchWorkflowReplayEvents } from '../api';
import type { RrwebReplayEvent } from '../types';
import { ReplayPlayer } from './ReplayPlayer';

interface Props {
  workflowId: string;
  title?: string;
  onClose: () => void;
}

export function ReplayModal({ workflowId, title, onClose }: Props) {
  const [events, setEvents] = useState<RrwebReplayEvent[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);

    fetchWorkflowReplayEvents(workflowId)
      .then((result) => {
        if (!cancelled) setEvents(result.events);
      })
      .catch((err) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Failed to load replay');
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [workflowId]);

  return (
    <div className="modal-backdrop" role="presentation" onClick={onClose}>
      <div
        className="modal replay-modal"
        role="dialog"
        aria-modal="true"
        aria-label={title ?? 'Workflow replay'}
        onClick={(e) => e.stopPropagation()}
      >
        <header className="modal-header">
          <h3>{title ?? 'Example replay'}</h3>
          <button type="button" className="ghost" onClick={onClose}>
            Close
          </button>
        </header>

        {loading && <p className="muted">Loading replay…</p>}
        {error && <div className="banner error">{error}</div>}
        {events && !loading && !error && (
          <>
            <p className="muted replay-meta">{events.length} events loaded</p>
            <ReplayPlayer events={events} />
          </>
        )}
      </div>
    </div>
  );
}
