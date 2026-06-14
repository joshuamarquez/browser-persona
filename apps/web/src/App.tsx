import { useCallback, useEffect, useState } from 'react';
import { fetchCapabilities, fetchPatterns, fetchProposals } from './api';
import { Capabilities } from './components/Capabilities';
import { Inbox } from './components/Inbox';
import { Patterns } from './components/Patterns';
import type { Capability, Pattern, Proposal } from './types';
import './App.css';

type Tab = 'inbox' | 'patterns' | 'library';

export default function App() {
  const [tab, setTab] = useState<Tab>('inbox');
  const [proposals, setProposals] = useState<Proposal[]>([]);
  const [patterns, setPatterns] = useState<Pattern[]>([]);
  const [capabilities, setCapabilities] = useState<Capability[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async (options?: { silent?: boolean }) => {
    if (!options?.silent) {
      setLoading(true);
    }
    setError(null);
    try {
      const [proposalRes, patternRes, capRes] = await Promise.all([
        fetchProposals(),
        fetchPatterns(),
        fetchCapabilities(),
      ]);
      setProposals(proposalRes.proposals);
      setPatterns(patternRes.patterns);
      setCapabilities(capRes.capabilities);
    } catch (err) {
      if (!options?.silent) {
        setError(err instanceof Error ? err.message : 'Failed to load data');
      }
    } finally {
      if (!options?.silent) {
        setLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const selectTab = (next: Tab) => {
    setTab(next);
    if (next === 'patterns' || next === 'inbox') {
      void refresh({ silent: true });
    }
  };

  return (
    <div className="app">
      <header className="topbar">
        <div>
          <h1>Browser Persona</h1>
          <p className="subtitle">Review detected workflows and approve capabilities</p>
        </div>
        <button type="button" className="ghost" onClick={() => void refresh()} disabled={loading}>
          Refresh
        </button>
      </header>

      <nav className="tabs">
        <button
          type="button"
          className={tab === 'inbox' ? 'active' : ''}
          onClick={() => selectTab('inbox')}
        >
          Inbox {proposals.length > 0 && <span className="count">{proposals.length}</span>}
        </button>
        <button
          type="button"
          className={tab === 'patterns' ? 'active' : ''}
          onClick={() => selectTab('patterns')}
        >
          Patterns {patterns.length > 0 && <span className="count">{patterns.length}</span>}
        </button>
        <button
          type="button"
          className={tab === 'library' ? 'active' : ''}
          onClick={() => selectTab('library')}
        >
          Library
        </button>
      </nav>

      <main className="content">
        {error && <div className="banner error">{error}</div>}
        {loading ? (
          <p className="muted">Loading…</p>
        ) : (
          <>
            {tab === 'inbox' && <Inbox proposals={proposals} onUpdated={refresh} />}
            {tab === 'patterns' && <Patterns patterns={patterns} onUpdated={refresh} />}
            {tab === 'library' && <Capabilities capabilities={capabilities} />}
          </>
        )}
      </main>
    </div>
  );
}
