import { useLayoutEffect, useRef, useState } from 'react';
import { Replayer } from '@rrweb/replay';
import type { eventWithTime } from '@rrweb/types';
import '@rrweb/replay/dist/style.css';
import type { RrwebReplayEvent } from '../types';

interface Props {
  events: RrwebReplayEvent[];
  height?: number;
}

const RRWEB_META = 4;

function getRecordedViewport(events: RrwebReplayEvent[]): { width: number; height: number } {
  for (const event of events) {
    if (event.type !== RRWEB_META || !event.data || typeof event.data !== 'object') continue;
    const data = event.data as { width?: number; height?: number };
    if (data.width && data.height) {
      return { width: data.width, height: data.height };
    }
  }
  return { width: 1280, height: 720 };
}

function fitReplayerWrapper(
  stage: HTMLElement,
  wrapper: HTMLElement,
  viewport: { width: number; height: number },
): void {
  const availableWidth = stage.clientWidth || viewport.width;
  const availableHeight = stage.clientHeight || viewport.height;
  const scale = Math.min(availableWidth / viewport.width, availableHeight / viewport.height);

  wrapper.style.width = `${viewport.width}px`;
  wrapper.style.height = `${viewport.height}px`;
  wrapper.style.transformOrigin = 'top left';
  wrapper.style.transform = `scale(${scale})`;

  const scaledWidth = viewport.width * scale;
  const scaledHeight = viewport.height * scale;
  wrapper.style.marginLeft = `${Math.max(0, (availableWidth - scaledWidth) / 2)}px`;
  wrapper.style.marginTop = `${Math.max(0, (availableHeight - scaledHeight) / 2)}px`;
}

export function ReplayPlayer({ events, height = 560 }: Props) {
  const stageRef = useRef<HTMLDivElement>(null);
  const replayerRef = useRef<Replayer | null>(null);
  const viewportRef = useRef(getRecordedViewport(events));
  const [initError, setInitError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);

  useLayoutEffect(() => {
    viewportRef.current = getRecordedViewport(events);
  }, [events]);

  useLayoutEffect(() => {
    const stage = stageRef.current;
    if (!stage || events.length === 0) return;

    let cancelled = false;
    let replayer: Replayer | null = null;
    let resizeObserver: ResizeObserver | undefined;

    const applyFit = () => {
      const wrapper = stage.querySelector('.replayer-wrapper') as HTMLElement | null;
      if (wrapper) fitReplayerWrapper(stage, wrapper, viewportRef.current);
    };

    setInitError(null);
    setReady(false);
    stage.innerHTML = '';

    const frame = requestAnimationFrame(() => {
      if (cancelled || !stageRef.current) return;

      try {
        replayer = new Replayer(events as eventWithTime[], {
          root: stage,
          showWarning: false,
        });
        replayerRef.current = replayer;

        replayer.on('fullsnapshot-rebuilded', applyFit);
        replayer.on('resize', applyFit);
        replayer.pause();

        requestAnimationFrame(applyFit);

        resizeObserver = new ResizeObserver(applyFit);
        resizeObserver.observe(stage);

        setReady(true);
      } catch (err) {
        setInitError(err instanceof Error ? err.message : 'Failed to start replay');
      }
    });

    return () => {
      cancelled = true;
      cancelAnimationFrame(frame);
      resizeObserver?.disconnect();
      replayer?.destroy();
      replayerRef.current = null;
      stage.innerHTML = '';
    };
  }, [events, height]);

  if (events.length === 0) {
    return <p className="muted">No replay events available.</p>;
  }

  if (initError) {
    return <div className="banner error">{initError}</div>;
  }

  return (
    <div className="replay-shell">
      <div ref={stageRef} className="replay-stage" style={{ height }} />
      <div className="replay-controls">
        <button type="button" disabled={!ready} onClick={() => replayerRef.current?.play()}>
          Play
        </button>
        <button type="button" disabled={!ready} onClick={() => replayerRef.current?.pause()}>
          Pause
        </button>
      </div>
    </div>
  );
}
