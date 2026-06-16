import { useState } from 'react';
import type { Proposal, TaskRisk } from '../types';
import { proposalDisplayName } from '../types';
import { approveProposal, rejectProposal } from '../api';
import { formatCategory, formatConfidence, parseCategoryInput } from '../utils';

interface Props {
  proposals: Proposal[];
  onUpdated: () => void;
}

function riskBadgeClass(risk: TaskRisk): string {
  if (risk === 'high') return 'badge risk-high';
  if (risk === 'medium') return 'badge risk-medium';
  return 'badge risk-low';
}

export function Inbox({ proposals, onUpdated }: Props) {
  const [editing, setEditing] = useState<Proposal | null>(null);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [category, setCategory] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  function openEdit(p: Proposal) {
    setEditing(p);
    setName(proposalDisplayName(p.proposal));
    setDescription(p.proposal.description);
    setCategory(p.proposal.category_path.join(' > '));
    setError(null);
  }

  async function handleApprove(p: Proposal, withEdits: boolean) {
    setBusy(p.id);
    setError(null);
    try {
      await approveProposal(
        p.id,
        withEdits
          ? {
              name,
              description,
              category_path: parseCategoryInput(category),
            }
          : undefined,
      );
      setEditing(null);
      onUpdated();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Approve failed');
    } finally {
      setBusy(null);
    }
  }

  async function handleReject(id: string) {
    setBusy(id);
    setError(null);
    try {
      await rejectProposal(id);
      onUpdated();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Reject failed');
    } finally {
      setBusy(null);
    }
  }

  if (proposals.length === 0) {
    return (
      <div className="empty">
        <p>No proposals waiting for review.</p>
        <p className="muted">
          Intent proposals appear after pipeline segmentation when you record a journey with the extension.
        </p>
      </div>
    );
  }

  return (
    <div className="stack">
      {error && <div className="banner error">{error}</div>}
      {proposals.map((p) => {
        const displayName = proposalDisplayName(p.proposal);

        return (
          <article key={p.id} className="card">
            <header className="card-header">
              <div>
                <div className="eyebrow">{formatCategory(p.proposal.category_path)}</div>
                <h2>{displayName}</h2>
              </div>
              <span className="badge">{formatConfidence(Number(p.confidence))}</span>
            </header>

            <p className="description">{p.proposal.description}</p>

            <dl className="meta">
              <div>
                <dt>Domain</dt>
                <dd>{p.proposal.domain}</dd>
              </div>
            </dl>

            <div className="task-list">
              <strong>Tasks</strong>
              <ol>
                {p.proposal.tasks.map((task) => (
                  <li key={task.id}>
                    <span>{task.goal}</span>
                    <span className={riskBadgeClass(task.risk)}>{task.risk}</span>
                    <span className="muted small">
                      verify: {task.verification.kind} — {task.verification.description}
                    </span>
                  </li>
                ))}
              </ol>
            </div>

            {p.proposal.parameters.length > 0 && (
              <p className="params">
                <strong>Parameters:</strong>{' '}
                {p.proposal.parameters.map((param) => param.name).join(', ')}
              </p>
            )}

            <details className="reasoning">
              <summary>LLM reasoning</summary>
              <p>{p.proposal.reasoning}</p>
            </details>

            <div className="actions">
              <button
                type="button"
                className="primary"
                disabled={busy === p.id}
                onClick={() => handleApprove(p, false)}
              >
                Approve
              </button>
              <button type="button" disabled={busy === p.id} onClick={() => openEdit(p)}>
                Edit &amp; approve
              </button>
              <button
                type="button"
                className="danger"
                disabled={busy === p.id}
                onClick={() => handleReject(p.id)}
              >
                Reject
              </button>
            </div>
          </article>
        );
      })}

      {editing && (
        <div className="modal-backdrop" onClick={() => setEditing(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3>Edit before approve</h3>
            <label>
              Name
              <input value={name} onChange={(e) => setName(e.target.value)} />
            </label>
            <label>
              Category (use &gt; between levels)
              <input value={category} onChange={(e) => setCategory(e.target.value)} />
            </label>
            <label>
              Description
              <textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={4} />
            </label>
            <div className="actions">
              <button
                type="button"
                className="primary"
                disabled={busy === editing.id}
                onClick={() => handleApprove(editing, true)}
              >
                Save &amp; approve
              </button>
              <button type="button" onClick={() => setEditing(null)}>
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
