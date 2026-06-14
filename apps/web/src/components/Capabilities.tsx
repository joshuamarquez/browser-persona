import { useState } from 'react';
import type { Capability } from '../types';
import { downloadPlaywrightScript } from '../api';
import { formatCategory, formatConfidence } from '../utils';
import { RunCapabilityModal } from './RunCapabilityModal';

interface Props {
  capabilities: Capability[];
}

export function Capabilities({ capabilities }: Props) {
  const [runningCapability, setRunningCapability] = useState<Capability | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const handleExport = async (cap: Capability) => {
    setActionError(null);
    try {
      await downloadPlaywrightScript(cap.id, cap.name);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Export failed');
    }
  };

  if (capabilities.length === 0) {
    return (
      <div className="empty">
        <p>No approved capabilities yet.</p>
        <p className="muted">Approve proposals from the Inbox to build your library.</p>
      </div>
    );
  }

  const grouped = new Map<string, Capability[]>();
  for (const cap of capabilities) {
    const key = formatCategory(cap.category_path);
    const list = grouped.get(key) ?? [];
    list.push(cap);
    grouped.set(key, list);
  }

  return (
    <div className="stack">
      {actionError && <div className="banner error">{actionError}</div>}
      {[...grouped.entries()].map(([category, caps]) => (
        <section key={category}>
          <h2 className="section-title">{category}</h2>
          <div className="stack">
            {caps.map((cap) => (
              <article key={cap.id} className="card compact">
                <header className="card-header">
                  <h3>{cap.name}</h3>
                  <span className="badge">{formatConfidence(Number(cap.confidence))}</span>
                </header>
                <p className="description">{cap.description}</p>
                <div className="actions">
                  <button
                    type="button"
                    onClick={() => void handleExport(cap)}
                  >
                    Export Playwright
                  </button>
                  <button
                    type="button"
                    className="primary"
                    onClick={() => setRunningCapability(cap)}
                  >
                    Run headful
                  </button>
                </div>
              </article>
            ))}
          </div>
        </section>
      ))}

      {runningCapability && (
        <RunCapabilityModal
          capability={runningCapability}
          onClose={() => setRunningCapability(null)}
        />
      )}
    </div>
  );
}
