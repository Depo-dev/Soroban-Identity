import { useEffect, useMemo, useRef, useState, useCallback } from 'react';

export interface ContractEventFilter {
  contractId?: string;
  topic?: string[];
  eventTypes?: string[];
  onEvent?: (type: string, data: StreamedContractEvent) => void;
}

export interface StreamedContractEvent {
  id: string;
  type: string;
  contractId: string;
  topic: string[];
  value: unknown;
  ledger: number;
  txHash: string;
  timestamp: string;
}

const MAX_EVENTS = 200;
export function useContractEvents(filter?: ContractEventFilter) {
  const [events, setEvents] = useState<StreamedContractEvent[]>([]);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const sourceRef = useRef<EventSource | null>(null);
  const filterRef = useRef(filter);
  filterRef.current = filter;

  const eventsUrl = import.meta.env.VITE_EVENTS_URL ?? 'http://localhost:3001/events';

  const topicKey = filter?.topic?.join(',') ?? '';
  const eventTypesKey = filter?.eventTypes?.join(',') ?? '';

  const streamUrl = useMemo(() => {
    const url = new URL(eventsUrl);
    if (filter?.contractId) {
      url.searchParams.set('contractId', filter.contractId);
    }
    if (filter?.topic && filter.topic.length > 0) {
      url.searchParams.set('topic', filter.topic.join(','));
    }
    return url.toString();
  }, [eventsUrl, filter?.contractId, topicKey]);

  const shouldIncludeEvent = useCallback((eventType: string): boolean => {
    const eventTypes = filterRef.current?.eventTypes;
    if (!eventTypes || eventTypes.length === 0) {
      return true;
    }
    return eventTypes.includes(eventType);
  }, []);

  useEffect(() => {
    const source = new EventSource(streamUrl);
    sourceRef.current = source;

    source.addEventListener('connected', () => {
      setConnected(true);
      setError(null);
    });

    source.addEventListener('contract-event', (evt) => {
      try {
        const parsed = JSON.parse((evt as MessageEvent).data) as StreamedContractEvent;
        if (shouldIncludeEvent(parsed.type)) {
          setEvents((prev) => [parsed, ...prev].slice(0, MAX_EVENTS));
          filterRef.current?.onEvent?.(parsed.type, parsed);
        }
      } catch {
        // Ignore invalid payloads
      }
    });

    source.addEventListener('heartbeat', () => {
      setConnected(true);
    });

    source.onerror = () => {
      setConnected(false);
      setError('Event stream disconnected');
    };

    return () => {
      source.close();
      sourceRef.current = null;
      setConnected(false);
    };
    // shouldIncludeEvent and filterRef.current.onEvent are intentionally
    // excluded: shouldIncludeEvent reads live filterRef state and has no
    // dependencies, and eventTypesKey/streamUrl already capture every input
    // that should reopen the connection.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [streamUrl, eventTypesKey]);

  return { events, connected, error };
}
