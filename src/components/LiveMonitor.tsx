import { forwardRef, useEffect, useId, useImperativeHandle, useMemo, useRef, useState, type FormEvent, type KeyboardEvent, type ReactNode } from 'react';
import { AlertTriangle, Check, ChevronsDown, CirclePause, CirclePlay, Copy, Eraser, LoaderCircle, PlugZap, RotateCw, Search, Send, TerminalSquare, WifiOff, X } from 'lucide-react';
import { listenForSerialData, listenForSerialStatus, takePendingNativeSerialData, type SerialDataEvent } from '../lib/serial';
import { lineEndingText, type DisplayEncoding, type LineEnding } from '../lib/preferences';
import { MobileSharePanel } from './MobileSharePanel';
import './live-monitor.css';
import './live-monitor-preferences.css';

export type MonitorConnectionState = 'connected' | 'reconnecting' | 'disconnected' | 'error';

export type MonitorLine = {
  id: string;
  timestamp: string;
  text: string;
  kind?: 'data' | 'system' | 'error';
};

type DisplayChange = {
  line: MonitorLine;
  type: 'append' | 'replace';
};

type OutputFilterPreset = 'all' | 'errors' | 'wifi' | 'custom';
type SendMode = 'text' | 'hex';
type CommandHistory = Record<SendMode, string[]>;
type PersistedComposerState = {
  version: 1;
  sendMode: SendMode;
  lineEnding: LineEnding;
  commandHistory: CommandHistory;
};

// The terminal keeps at most 500 rendered rows. Bound an unfinished logical
// line as well: serial devices are free to send a continuous stream without a
// CR or LF, and hexadecimal rendering expands every byte into three characters.
const MAX_VISIBLE_DATA_LINE_CHARACTERS = 4096;
const CONTINUATION_PREFIX = '↪ ';
const CONTINUATION_SUFFIX = ' ↪ continued';
const MAX_QUEUED_DISPLAY_CHANGES = 2_048;
const MAX_PENDING_SERIAL_EVENTS = 256;
const MAX_COMMAND_HISTORY = 50;
const MAX_SERIAL_WRITE_BYTES = 64 * 1024;
const MAX_PERSISTED_HISTORY_CHARACTERS_PER_MODE = 32 * 1024;
const COMPOSER_STORAGE_PREFIX = 'baudtide.serial-composer.';
const ERROR_FILTER_SOURCE = String.raw`(?<![\p{L}\p{N}_])(?:error|err|fail(?:ed|ure)?|panic|fatal|exception|abort(?:ed)?)(?![\p{L}\p{N}_])`;
const WIFI_FILTER_SOURCE = String.raw`(?<![\p{L}\p{N}_])(?:wi-?fi|wlan|ssid|bssid|rssi|ip address|disconnect(?:ed|ion)?|reconnect(?:ed|ing)?)(?![\p{L}\p{N}_])`;
const ERROR_LINE_PATTERN = new RegExp(ERROR_FILTER_SOURCE, 'iu');
const WIFI_LINE_PATTERN = new RegExp(WIFI_FILTER_SOURCE, 'iu');

function literalPattern(text: string, global = false) {
  const escaped = text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(escaped, global ? 'giu' : 'iu');
}

function lineEndingLabel(value: LineEnding) {
  return { lf: 'LF (\\n)', crlf: 'CRLF (\\r\\n)', cr: 'CR (\\r)', none: 'None' }[value];
}

function isLineEnding(value: unknown): value is LineEnding {
  return value === 'lf' || value === 'crlf' || value === 'cr' || value === 'none';
}

function boundedPersistedHistory(value: unknown, remainingCharacters: { value: number }) {
  if (!Array.isArray(value)) return [];
  const retained: string[] = [];
  for (let index = value.length - 1; index >= 0 && retained.length < MAX_COMMAND_HISTORY; index -= 1) {
    const entry = value[index];
    if (typeof entry !== 'string' || entry.length > remainingCharacters.value) continue;
    retained.unshift(entry);
    remainingCharacters.value -= entry.length;
  }
  return retained;
}

function loadComposerState(sessionId: string | undefined, fallbackLineEnding: LineEnding): PersistedComposerState {
  const fallback: PersistedComposerState = {
    version: 1,
    sendMode: 'text',
    lineEnding: fallbackLineEnding,
    commandHistory: { text: [], hex: [] },
  };
  if (!sessionId || typeof window === 'undefined') return fallback;
  try {
    const stored = window.sessionStorage.getItem(`${COMPOSER_STORAGE_PREFIX}${sessionId}`);
    if (!stored) return fallback;
    const parsed = JSON.parse(stored) as Partial<PersistedComposerState>;
    if (parsed.version !== 1) return fallback;
    return {
      version: 1,
      sendMode: parsed.sendMode === 'hex' ? 'hex' : 'text',
      lineEnding: isLineEnding(parsed.lineEnding) ? parsed.lineEnding : fallbackLineEnding,
      commandHistory: {
        text: boundedPersistedHistory(parsed.commandHistory?.text, { value: MAX_PERSISTED_HISTORY_CHARACTERS_PER_MODE }),
        hex: boundedPersistedHistory(parsed.commandHistory?.hex, { value: MAX_PERSISTED_HISTORY_CHARACTERS_PER_MODE }),
      },
    };
  } catch {
    return fallback;
  }
}

function persistComposerState(sessionId: string | undefined, state: PersistedComposerState) {
  if (!sessionId || typeof window === 'undefined') return;
  try {
    window.sessionStorage.setItem(`${COMPOSER_STORAGE_PREFIX}${sessionId}`, JSON.stringify({
      ...state,
      commandHistory: {
        text: boundedPersistedHistory(state.commandHistory.text, { value: MAX_PERSISTED_HISTORY_CHARACTERS_PER_MODE }),
        hex: boundedPersistedHistory(state.commandHistory.hex, { value: MAX_PERSISTED_HISTORY_CHARACTERS_PER_MODE }),
      },
    }));
  } catch {
    // Sending must remain available when storage is disabled or full.
  }
}

function parseHexBytes(input: string): { bytes: number[] } | { error: string } {
  const trimmed = input.trim();
  if (!trimmed) return { error: 'Enter at least one byte, for example 48 65 6C 6C 6F.' };
  // Commas and whitespace may be freely combined around one separator, but a
  // comma can never stand in for a byte.
  const normalizedSeparators = trimmed.replace(/\s*,\s*/g, ',');
  if (normalizedSeparators.startsWith(',') || normalizedSeparators.endsWith(',') || normalizedSeparators.includes(',,')) {
    return { error: 'Use one comma or whitespace separator between each byte.' };
  }
  const tokens = trimmed.split(/[\s,]+/);
  if (tokens.length > MAX_SERIAL_WRITE_BYTES) {
    return { error: `Hex sends are limited to ${MAX_SERIAL_WRITE_BYTES.toLocaleString()} bytes.` };
  }
  const bytes: number[] = [];
  for (const token of tokens) {
    if (!/^(?:0x)?[\da-f]{2}$/i.test(token)) {
      return { error: `“${token}” is not a byte. Use two hex digits such as 7E or 0x7E.` };
    }
    bytes.push(Number.parseInt(token.replace(/^0x/i, ''), 16));
  }
  return { bytes };
}

function outputMatchPattern(preset: OutputFilterPreset, customFilter: string) {
  if (preset === 'errors') return ERROR_LINE_PATTERN;
  if (preset === 'wifi') return WIFI_LINE_PATTERN;
  if (preset === 'custom' && customFilter) return literalPattern(customFilter);
  return null;
}

function lineMatchesOutputFilter(line: MonitorLine, preset: OutputFilterPreset, pattern: RegExp | null) {
  if (preset === 'all') return true;
  if (preset === 'errors' && line.kind === 'error') return true;
  return !pattern || pattern.test(line.text);
}

function outputHighlightPattern(preset: OutputFilterPreset, customFilter: string) {
  if (preset === 'errors') return new RegExp(ERROR_FILTER_SOURCE, 'giu');
  if (preset === 'wifi') return new RegExp(WIFI_FILTER_SOURCE, 'giu');
  if (preset !== 'custom' || !customFilter) return null;
  return literalPattern(customFilter, true);
}

function HighlightedOutput({ text, pattern }: { text: string; pattern: RegExp | null }) {
  if (!pattern) return text;
  const matches = [...text.matchAll(pattern)];
  if (!matches.length) return text;
  const output: ReactNode[] = [];
  let cursor = 0;
  matches.forEach((match, index) => {
    const start = match.index ?? 0;
    if (start > cursor) output.push(text.slice(cursor, start));
    output.push(<mark className="sd-terminal-match" key={`${start}-${index}`}>{match[0]}</mark>);
    cursor = start + match[0].length;
  });
  if (cursor < text.length) output.push(text.slice(cursor));
  return <>{output}</>;
}

function sliceWithoutSplittingSurrogatePair(text: string, maxLength: number) {
  let end = Math.min(text.length, maxLength);
  if (end > 0 && end < text.length) {
    const finalCharacter = text.charCodeAt(end - 1);
    const followingCharacter = text.charCodeAt(end);
    const endsWithHighSurrogate = finalCharacter >= 0xD800 && finalCharacter <= 0xDBFF;
    const startsWithLowSurrogate = followingCharacter >= 0xDC00 && followingCharacter <= 0xDFFF;
    if (endsWithHighSurrogate && startsWithLowSurrogate) end -= 1;
  }
  return text.slice(0, end);
}

export type LiveMonitorProps = {
  sessionName: string;
  port: string;
  baudRate: number;
  lineEnding?: LineEnding;
  displayEncoding?: DisplayEncoding;
  showTimestamps?: boolean;
  initialLines?: MonitorLine[];
  initialConnectionState?: MonitorConnectionState;
  onSend?: (text: string) => void | Promise<void>;
  onSendBytes?: (bytes: number[]) => void | Promise<void>;
  onReconnect?: () => void | Promise<void>;
  onDisconnect?: () => void | Promise<void>;
  onClear?: () => void;
  onClose?: () => void;
  onConnectionStateChange?: (state: MonitorConnectionState) => void;
  /** Called when the native backend reports a terminal reader/logging failure. */
  onNativeSessionEnded?: () => void;
  onNativeStorageLimit?: () => void;
  /** Called when the WebView cannot finish its listener/startup handoff. */
  onNativeSessionStartupFailure?: () => void | Promise<void>;
  sessionId?: string;
  nativeSession?: boolean;
  /** Absolute local path returned for a desktop session's raw capture. */
  capturePath?: string;
};

export type LiveMonitorHandle = {
  toggleDisplayPause: () => void;
  requestClear: () => void;
  focusFind: () => void;
};

function currentTimestamp() {
  const now = new Date();
  const pad = (value: number, width = 2) => String(value).padStart(width, '0');
  return `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}.${pad(now.getMilliseconds(), 3)}`;
}

function timestampForEvent(event: SerialDataEvent) {
  const date = new Date(event.timestamp);
  return Number.isNaN(date.getTime()) ? currentTimestamp() : `${date.toTimeString().slice(0, 8)}.${String(date.getMilliseconds()).padStart(3, '0')}`;
}

function displayTextForEvent(event: SerialDataEvent, encoding: DisplayEncoding, decoder: TextDecoder) {
  if (encoding === 'utf8') return decoder.decode(Uint8Array.from(event.bytes), { stream: true });
  if (encoding === 'ascii') {
    return event.bytes.map((byte) => {
      if (byte === 13) return '\r';
      if (byte === 10) return '\n';
      if (byte === 9) return '\t';
      return byte >= 32 && byte <= 126 ? String.fromCharCode(byte) : `\\x${byte.toString(16).padStart(2, '0').toUpperCase()}`;
    }).join('');
  }
  // Keep raw CR/LF delimiters so the terminal's streaming line parser works the
  // same in hexadecimal mode. All other bytes are represented without changing
  // the raw capture written by the backend.
  return event.bytes.map((byte) => byte === 13 ? '\r' : byte === 10 ? '\n' : `${byte.toString(16).padStart(2, '0').toUpperCase()} `).join('');
}

export const LiveMonitor = forwardRef<LiveMonitorHandle, LiveMonitorProps>(function LiveMonitor({
  sessionName,
  port,
  baudRate,
  lineEnding = 'lf',
  displayEncoding = 'utf8',
  showTimestamps = true,
  initialLines,
  initialConnectionState = 'connected',
  onSend,
  onSendBytes,
  onReconnect,
  onDisconnect,
  onClear,
  onClose,
  onConnectionStateChange,
  onNativeSessionEnded,
  onNativeStorageLimit,
  onNativeSessionStartupFailure,
  sessionId,
  nativeSession = false,
  capturePath,
}: LiveMonitorProps, ref) {
  const [initialComposerState] = useState(() => loadComposerState(sessionId, lineEnding));
  const [connectionState, setConnectionState] = useState<MonitorConnectionState>(nativeSession ? initialConnectionState : 'disconnected');
  const [lines, setLines] = useState<MonitorLine[]>(() => (initialLines ?? []).slice(-500));
  const [isPaused, setPaused] = useState(false);
  const [pausedLines, setPausedLines] = useState<MonitorLine[]>([]);
  const [waitingLines, setWaitingLines] = useState(0);
  const [autoScroll, setAutoScroll] = useState(true);
  const [outgoing, setOutgoing] = useState('');
  const [sendMode, setSendMode] = useState<SendMode>(initialComposerState.sendMode);
  // The session setting is the starting point; this selector is deliberately
  // local so changing it while working does not rewrite the app-wide default.
  const [sendLineEnding, setSendLineEnding] = useState<LineEnding>(initialComposerState.lineEnding);
  const [commandHistory, setCommandHistory] = useState<CommandHistory>(initialComposerState.commandHistory);
  const [composerSessionId, setComposerSessionId] = useState(sessionId);
  const [historyIndex, setHistoryIndex] = useState<number | null>(null);
  const [sendError, setSendError] = useState<string | null>(null);
  const [isSending, setSending] = useState(false);
  const [showClearConfirm, setShowClearConfirm] = useState(false);
  const [showDisconnectConfirm, setShowDisconnectConfirm] = useState(false);
  const [isReconnecting, setReconnecting] = useState(false);
  const [isFindOpen, setFindOpen] = useState(false);
  const [filterPreset, setFilterPreset] = useState<OutputFilterPreset>('all');
  const [outputFilter, setOutputFilter] = useState('');
  const [capturePathCopyStatus, setCapturePathCopyStatus] = useState<'idle' | 'copied' | 'error'>('idle');
  const filterPanelId = useId();
  const filterInputId = useId();
  const filterStatusId = useId();
  const sendInputId = useId();
  const sendModeId = useId();
  const sendEndingId = useId();
  const sendHintId = useId();
  const sendErrorId = useId();
  const outputRef = useRef<HTMLDivElement>(null);
  const filterButtonRef = useRef<HTMLButtonElement>(null);
  const findInputRef = useRef<HTMLInputElement>(null);
  // A serial read is an arbitrary byte chunk, so a terminal line can span many
  // events. Keep the visible, unfinished line separate from line termination.
  const currentDataLineRef = useRef<MonitorLine | null>(null);
  const skipNextLineFeedRef = useRef(false);
  const lineIdRef = useRef(0);
  const pausedRef = useRef(false);
  const queuedChangesRef = useRef<DisplayChange[]>([]);
  const renderFrameRef = useRef<number | null>(null);
  const onConnectionStateChangeRef = useRef(onConnectionStateChange);
  const onNativeSessionEndedRef = useRef(onNativeSessionEnded);
  const onNativeStorageLimitRef = useRef(onNativeStorageLimit);
  const onNativeSessionStartupFailureRef = useRef(onNativeSessionStartupFailure);
  const utf8DecoderRef = useRef<TextDecoder | null>(null);
  const displayOverloadReportedRef = useRef(false);
  const historyDraftRef = useRef('');
  const modeDraftsRef = useRef<Record<SendMode, string>>({ text: '', hex: '' });
  const capturePathCopyResetRef = useRef<number | undefined>(undefined);

  // A mounted monitor normally keeps the same id across reconnects. If React
  // ever reuses it for another session, restore only that session's bounded
  // composer state instead of leaking commands across the boundary.
  useEffect(() => {
    if (composerSessionId === sessionId) return;
    const restored = loadComposerState(sessionId, lineEnding);
    setOutgoing('');
    setSendMode(restored.sendMode);
    setSendLineEnding(restored.lineEnding);
    setCommandHistory(restored.commandHistory);
    setHistoryIndex(null);
    historyDraftRef.current = '';
    modeDraftsRef.current = { text: '', hex: '' };
    setSendError(null);
    setComposerSessionId(sessionId);
  }, [composerSessionId, lineEnding, sessionId]);

  useEffect(() => {
    setCapturePathCopyStatus('idle');
  }, [capturePath]);

  useEffect(() => () => {
    if (capturePathCopyResetRef.current !== undefined) window.clearTimeout(capturePathCopyResetRef.current);
  }, []);

  useEffect(() => {
    if (composerSessionId !== sessionId) return;
    persistComposerState(sessionId, {
      version: 1,
      sendMode,
      lineEnding: sendLineEnding,
      commandHistory,
    });
  }, [commandHistory, composerSessionId, sendLineEnding, sendMode, sessionId]);

  useEffect(() => {
    onConnectionStateChangeRef.current = onConnectionStateChange;
  }, [onConnectionStateChange]);

  useEffect(() => {
    onNativeSessionEndedRef.current = onNativeSessionEnded;
  }, [onNativeSessionEnded]);

  useEffect(() => {
    onNativeStorageLimitRef.current = onNativeStorageLimit;
  }, [onNativeStorageLimit]);

  useEffect(() => {
    onNativeSessionStartupFailureRef.current = onNativeSessionStartupFailure;
  }, [onNativeSessionStartupFailure]);

  const updateConnectionState = (state: MonitorConnectionState) => {
    setConnectionState(state);
    onConnectionStateChangeRef.current?.(state);
  };

  const visibleLines = useMemo(() => isPaused ? pausedLines : lines, [isPaused, lines, pausedLines]);
  const normalizedOutputFilter = outputFilter.trim();
  const matchPattern = useMemo(() => outputMatchPattern(filterPreset, normalizedOutputFilter), [filterPreset, normalizedOutputFilter]);
  const filteredLines = useMemo(() => {
    return visibleLines.filter((line) => lineMatchesOutputFilter(line, filterPreset, matchPattern));
  }, [filterPreset, matchPattern, visibleLines]);
  const highlightPattern = useMemo(() => outputHighlightPattern(filterPreset, normalizedOutputFilter), [filterPreset, normalizedOutputFilter]);
  const filterIsActive = filterPreset !== 'all' && (filterPreset !== 'custom' || Boolean(normalizedOutputFilter));

  const applyQueuedDisplayChanges = () => {
    const batch = queuedChangesRef.current.splice(0);
    if (!batch.length) return;
    const appendedLines = batch.filter((change) => change.type === 'append').length;
    if (pausedRef.current && appendedLines) setWaitingLines((count) => Math.min(500, count + appendedLines));
    setLines((current) => {
      const next = [...current];
      const lineIndexes = new Map(next.map((line, index) => [line.id, index]));
      for (const change of batch) {
        if (change.type === 'append') {
          lineIndexes.set(change.line.id, next.length);
          next.push(change.line);
          continue;
        }
        const index = lineIndexes.get(change.line.id);
        if (index !== undefined) next[index] = change.line;
      }
      return next.slice(-500);
    });
  };

  const queueDisplayChanges = (changes: DisplayChange[]) => {
    if (!changes.length) return;
    if (queuedChangesRef.current.length + changes.length > MAX_QUEUED_DISPLAY_CHANGES) {
      if (!displayOverloadReportedRef.current) {
        displayOverloadReportedRef.current = true;
        currentDataLineRef.current = null;
        skipNextLineFeedRef.current = false;
        queuedChangesRef.current = [{ type: 'append', line: {
          id: `display-overload-${Date.now()}`,
          timestamp: currentTimestamp(),
          text: 'Live display fell behind and skipped output. The raw capture contains all persisted bytes.',
          kind: 'error',
        } }];
      }
      return;
    }
    queuedChangesRef.current.push(...changes);
    if (renderFrameRef.current !== null) return;
    renderFrameRef.current = window.requestAnimationFrame(() => {
      renderFrameRef.current = null;
      applyQueuedDisplayChanges();
    });
  };

  const flushDisplayChanges = () => {
    if (renderFrameRef.current !== null) {
      window.cancelAnimationFrame(renderFrameRef.current);
      renderFrameRef.current = null;
    }
    applyQueuedDisplayChanges();
  };

  const appendDataText = (text: string, timestamp: string, session: string) => {
    let remainingText = text;
    let startsContinuation = false;

    do {
      let current = currentDataLineRef.current;
      if (!current) {
        current = {
          id: `${session}-${++lineIdRef.current}`,
          timestamp,
          text: startsContinuation ? CONTINUATION_PREFIX : '',
          kind: 'data' as const,
        };
        currentDataLineRef.current = current;
        queueDisplayChanges([{ type: 'append', line: current }]);
      }

      // Reserve room for the marker until the logical line is actually
      // terminated. That lets a later read turn this row into a clear visual
      // continuation without ever exceeding the per-row display bound.
      const availableCharacters = MAX_VISIBLE_DATA_LINE_CHARACTERS
        - CONTINUATION_SUFFIX.length
        - current.text.length;
      if (remainingText.length <= availableCharacters) {
        if (remainingText) {
          const line = { ...current, text: `${current.text}${remainingText}` };
          currentDataLineRef.current = line;
          queueDisplayChanges([{ type: 'replace', line }]);
        }
        return;
      }

      const visibleText = sliceWithoutSplittingSurrogatePair(remainingText, availableCharacters);
      if (visibleText) {
        current = { ...current, text: `${current.text}${visibleText}` };
        currentDataLineRef.current = current;
        queueDisplayChanges([{ type: 'replace', line: current }]);
      }
      const continuedLine = { ...current, text: `${current.text}${CONTINUATION_SUFFIX}` };
      currentDataLineRef.current = continuedLine;
      queueDisplayChanges([{ type: 'replace', line: continuedLine }]);
      remainingText = remainingText.slice(visibleText.length);
      currentDataLineRef.current = null;
      startsContinuation = true;
    } while (remainingText.length);
  };

  const terminateDataLine = (timestamp: string, session: string) => {
    // A delimiter with no preceding text is still an empty terminal line.
    if (!currentDataLineRef.current) appendDataText('', timestamp, session);
    currentDataLineRef.current = null;
  };

  const renderSerialChunk = (event: SerialDataEvent) => {
    const timestamp = timestampForEvent(event);
    const displayText = displayTextForEvent(event, displayEncoding, utf8DecoderRef.current ?? new TextDecoder());
    let textStart = 0;

    // CRLF can be split between reads. A CR always terminates the current line;
    // this flag makes a subsequent LF a part of that same delimiter instead of
    // creating an extra empty line.
    if (skipNextLineFeedRef.current) {
      skipNextLineFeedRef.current = false;
      if (displayText.startsWith('\n')) textStart = 1;
    }

    let segmentStart = textStart;
    for (let index = textStart; index < displayText.length; index += 1) {
      const character = displayText[index];
      if (skipNextLineFeedRef.current) {
        skipNextLineFeedRef.current = false;
        if (character === '\n') {
          segmentStart = index + 1;
          continue;
        }
      }
      if (character === '\r') {
        if (index > segmentStart) appendDataText(displayText.slice(segmentStart, index), timestamp, event.sessionId);
        terminateDataLine(timestamp, event.sessionId);
        skipNextLineFeedRef.current = true;
      } else if (character === '\n') {
        if (index > segmentStart) appendDataText(displayText.slice(segmentStart, index), timestamp, event.sessionId);
        terminateDataLine(timestamp, event.sessionId);
      }
      if (character === '\r' || character === '\n') segmentStart = index + 1;
    }
    if (segmentStart < displayText.length) appendDataText(displayText.slice(segmentStart), timestamp, event.sessionId);
  };

  const flushFinalPartialLine = () => {
    const decoderTail = utf8DecoderRef.current?.decode();
    if (decoderTail) appendDataText(decoderTail, currentTimestamp(), 'terminal');
    // The partial line is already represented in the display as it is received.
    // Force its pending render batch through before a terminal state/unmount can
    // cancel the animation frame, then close out parser-only delimiter state.
    flushDisplayChanges();
    currentDataLineRef.current = null;
    skipNextLineFeedRef.current = false;
  };

  const appendDisplayLine = (line: MonitorLine) => {
    setLines((current) => [...current, line].slice(-500));
  };

  useEffect(() => {
    if (nativeSession && sessionId) {
      let unlistenData: (() => void) | undefined;
      let unlistenStatus: (() => void) | undefined;
      let disposed = false;
      let terminalFailureReported = false;
      let startupFailureReported = false;
      let nextSequence = 1;
      const pendingEvents = new Map<number, SerialDataEvent>();
      currentDataLineRef.current = null;
      skipNextLineFeedRef.current = false;
      utf8DecoderRef.current = new TextDecoder();
      displayOverloadReportedRef.current = false;

      // Native reads can arrive between registering the listener and receiving
      // the buffered startup replay. Sequence numbers make both paths one
      // ordered stream, avoiding a missing prefix or duplicate render.
      const acceptSerialEvent = (event: SerialDataEvent) => {
        if (event.sequence < nextSequence) return;
        if (!pendingEvents.has(event.sequence) && pendingEvents.size >= MAX_PENDING_SERIAL_EVENTS) {
          // A missing event must not turn a display-ordering safeguard into an
          // unbounded memory queue. The raw capture remains authoritative.
          pendingEvents.clear();
          flushFinalPartialLine();
          appendDisplayLine({
            id: `display-sync-${sessionId}-${event.sequence}`,
            timestamp: currentTimestamp(),
            text: 'Live display skipped out-of-order data while resynchronizing. The raw capture contains all persisted bytes.',
            kind: 'error',
          });
          nextSequence = event.sequence;
        }
        pendingEvents.set(event.sequence, event);
        while (pendingEvents.has(nextSequence)) {
          const next = pendingEvents.get(nextSequence);
          pendingEvents.delete(nextSequence);
          nextSequence += 1;
          if (next) renderSerialChunk(next);
        }
      };
      const continueAfterSequence = (sequence: number) => {
        if (sequence <= nextSequence) return;
        nextSequence = sequence;
        while (pendingEvents.has(nextSequence)) {
          const next = pendingEvents.get(nextSequence);
          pendingEvents.delete(nextSequence);
          nextSequence += 1;
          if (next) renderSerialChunk(next);
        }
      };
      const reportBackendTerminalFailure = () => {
        if (terminalFailureReported) return;
        terminalFailureReported = true;
        flushFinalPartialLine();
        updateConnectionState('error');
        onNativeSessionEndedRef.current?.();
      };
      const reportFrontendStartupFailure = () => {
        if (startupFailureReported || disposed) return;
        startupFailureReported = true;
        flushFinalPartialLine();
        unlistenData?.();
        unlistenStatus?.();
        updateConnectionState('error');
        void onNativeSessionStartupFailureRef.current?.();
      };
      void Promise.allSettled([
        listenForSerialData(sessionId, (event: SerialDataEvent) => {
          acceptSerialEvent(event);
        }),
        listenForSerialStatus(sessionId, (event) => {
          if (event.status === 'error') {
            reportBackendTerminalFailure();
          }
          if (event.status === 'storage-limit') {
            flushFinalPartialLine();
            updateConnectionState('error');
            appendDisplayLine({ id: `storage-limit-${sessionId}`, timestamp: currentTimestamp(), text: event.message, kind: 'error' });
            onNativeStorageLimitRef.current?.();
          }
          if (event.status === 'disconnected') {
            flushFinalPartialLine();
            updateConnectionState('disconnected');
          }
          if (event.status === 'connected') updateConnectionState('connected');
        }),
      ]).then((listeners) => {
        const [dataResult, statusResult] = listeners;
        if (disposed) {
          if (dataResult.status === 'fulfilled') dataResult.value();
          if (statusResult.status === 'fulfilled') statusResult.value();
          return;
        }
        if (dataResult.status !== 'fulfilled' || statusResult.status !== 'fulfilled') {
          if (dataResult.status === 'fulfilled') dataResult.value();
          if (statusResult.status === 'fulfilled') statusResult.value();
          reportFrontendStartupFailure();
          return;
        }
        unlistenData = dataResult.value;
        unlistenStatus = statusResult.value;
        void takePendingNativeSerialData(sessionId)
          .then((handoff) => {
            if (disposed) return;
            handoff.events.forEach(acceptSerialEvent);
            if (handoff.droppedEventCount) {
              // The raw capture remains complete. Close any visible partial
              // line before resuming after the omitted startup chunks so text
              // from opposite sides of the gap is never joined together.
              flushFinalPartialLine();
              appendDisplayLine({
                id: `startup-overflow-${sessionId}`,
                timestamp: currentTimestamp(),
                text: `${handoff.droppedEventCount} startup data chunk${handoff.droppedEventCount === 1 ? '' : 's'} exceeded the live-display buffer; the raw log contains all received bytes.`,
                kind: 'error',
              });
            }
            // A recovered session may already have been in live-delivery mode
            // when this WebView registered its listener. If an event reached
            // that listener just before the handoff response, resume at that
            // earliest queued sequence instead of advancing past it.
            const resumeSequence = handoff.events.length
              ? handoff.nextSequence
              : Math.min(handoff.nextSequence, ...pendingEvents.keys());
            continueAfterSequence(resumeSequence);
          })
          .catch(() => {
            if (!disposed) reportFrontendStartupFailure();
          });
      });
      return () => {
        disposed = true;
        flushFinalPartialLine();
        unlistenData?.();
        unlistenStatus?.();
        utf8DecoderRef.current = null;
      };
    }
    return undefined;
  }, [nativeSession, sessionId]);

  useEffect(() => () => {
    flushFinalPartialLine();
  }, []);

  // App owns reconnection scheduling, including automatic retries after a
  // device disappears. Keep this mounted monitor aligned with that external
  // state so capture health does not remain stale until a new native ID exists.
  useEffect(() => {
    if (nativeSession) updateConnectionState(initialConnectionState);
    else updateConnectionState('disconnected');
  }, [initialConnectionState, nativeSession]);

  useEffect(() => {
    if (!isPaused && autoScroll && outputRef.current) outputRef.current.scrollTop = outputRef.current.scrollHeight;
  }, [filteredLines, isPaused, autoScroll]);

  const toggleDisplayPause = () => {
    if (isPaused) {
      pausedRef.current = false;
      setPaused(false);
      setPausedLines([]);
      setWaitingLines(0);
      return;
    }
    pausedRef.current = true;
    setPausedLines(lines);
    setWaitingLines(0);
    setPaused(true);
  };

  const goToEnd = () => {
    pausedRef.current = false;
    setPaused(false);
    setPausedLines([]);
    setWaitingLines(0);
    setAutoScroll(true);
    window.requestAnimationFrame(() => {
      if (outputRef.current) outputRef.current.scrollTop = outputRef.current.scrollHeight;
    });
  };

  const send = async (event: FormEvent) => {
    event.preventDefault();
    const payload = outgoing;
    if (!payload.trim() || isSending || connectionState !== 'connected') return;
    const hexPayload = sendMode === 'hex' ? parseHexBytes(payload) : null;
    if (hexPayload && 'error' in hexPayload) {
      setSendError(hexPayload.error);
      return;
    }
    const hexBytes = hexPayload && 'bytes' in hexPayload ? hexPayload.bytes : [];
    setSendError(null);
    setSending(true);
    try {
      if (sendMode === 'hex') {
        await onSendBytes?.(hexBytes);
      } else {
        await onSend?.(`${payload}${lineEndingText(sendLineEnding)}`);
      }
      const sentPreview = sendMode === 'hex'
        ? hexBytes.map((byte) => byte.toString(16).padStart(2, '0').toUpperCase()).join(' ')
        : payload;
      appendDisplayLine({ id: `sent-${Date.now()}`, timestamp: currentTimestamp(), text: `> ${sendMode === 'hex' ? '[hex] ' : ''}${sentPreview}`, kind: 'system' });
      setCommandHistory((history) => {
        const currentHistory = history[sendMode];
        if (currentHistory[currentHistory.length - 1] === payload) return history;
        return { ...history, [sendMode]: [...currentHistory, payload].slice(-MAX_COMMAND_HISTORY) };
      });
      setOutgoing('');
      setHistoryIndex(null);
      historyDraftRef.current = '';
      modeDraftsRef.current[sendMode] = '';
    } catch (error) {
      const message = error instanceof Error ? error.message : `Could not send serial ${sendMode === 'hex' ? 'bytes' : 'text'}.`;
      appendDisplayLine({ id: `send-error-${Date.now()}`, timestamp: currentTimestamp(), text: message, kind: 'error' });
    } finally {
      setSending(false);
    }
  };

  const changeOutgoing = (value: string) => {
    setOutgoing(value);
    if (historyIndex !== null) setHistoryIndex(null);
    historyDraftRef.current = value;
    modeDraftsRef.current[sendMode] = value;
    if (sendError) setSendError(null);
  };

  const changeSendMode = (mode: SendMode) => {
    if (mode === sendMode) return;
    modeDraftsRef.current[sendMode] = outgoing;
    setSendMode(mode);
    setOutgoing(modeDraftsRef.current[mode]);
    setHistoryIndex(null);
    historyDraftRef.current = modeDraftsRef.current[mode];
    setSendError(null);
  };

  const browseCommandHistory = (event: KeyboardEvent<HTMLInputElement>) => {
    const modeHistory = commandHistory[sendMode];
    if (event.nativeEvent.isComposing || event.altKey || event.ctrlKey || event.metaKey || !modeHistory.length) return;
    const input = event.currentTarget;
    const caretIsCollapsed = input.selectionStart === input.selectionEnd;
    const canMoveBack = caretIsCollapsed && input.selectionStart === 0;
    const canMoveForward = caretIsCollapsed && input.selectionStart === outgoing.length;

    if (event.key === 'ArrowUp' && canMoveBack) {
      event.preventDefault();
      if (historyIndex === null) historyDraftRef.current = outgoing;
      const nextIndex = historyIndex === null ? modeHistory.length - 1 : Math.max(0, historyIndex - 1);
      setHistoryIndex(nextIndex);
      setOutgoing(modeHistory[nextIndex]);
      return;
    }

    if (event.key === 'ArrowDown' && historyIndex !== null && canMoveForward) {
      event.preventDefault();
      const nextIndex = historyIndex + 1;
      if (nextIndex >= modeHistory.length) {
        setHistoryIndex(null);
        setOutgoing(historyDraftRef.current);
      } else {
        setHistoryIndex(nextIndex);
        setOutgoing(modeHistory[nextIndex]);
      }
    }
  };

  const reconnect = async () => {
    if (!nativeSession) {
      appendDisplayLine({ id: `preview-reconnect-${Date.now()}`, timestamp: currentTimestamp(), text: 'Browser preview cannot reconnect to a physical serial port. Open BaudTide desktop to connect.', kind: 'error' });
      return;
    }
    setReconnecting(true);
    updateConnectionState('reconnecting');
    try {
      await onReconnect?.();
      updateConnectionState('connected');
      appendDisplayLine({ id: `reconnected-${Date.now()}`, timestamp: currentTimestamp(), text: 'Connection restored. Logging resumed.', kind: 'system' });
    } catch {
      updateConnectionState('error');
    } finally {
      setReconnecting(false);
    }
  };

  const disconnect = async () => {
    try {
      await onDisconnect?.();
      flushFinalPartialLine();
      updateConnectionState('disconnected');
      setShowDisconnectConfirm(false);
      appendDisplayLine({ id: `disconnect-${Date.now()}`, timestamp: currentTimestamp(), text: 'Disconnected by user. Local log remains available.', kind: 'system' });
    } catch (error) {
      flushFinalPartialLine();
      const message = error instanceof Error ? error.message : 'Could not disconnect this serial session.';
      updateConnectionState('error');
      appendDisplayLine({ id: `disconnect-error-${Date.now()}`, timestamp: currentTimestamp(), text: message, kind: 'error' });
    }
  };

  const clear = () => {
    currentDataLineRef.current = null;
    skipNextLineFeedRef.current = false;
    utf8DecoderRef.current = new TextDecoder();
    if (renderFrameRef.current !== null) {
      window.cancelAnimationFrame(renderFrameRef.current);
      renderFrameRef.current = null;
    }
    queuedChangesRef.current = [];
    setLines([]);
    if (isPaused) setPausedLines([]);
    setWaitingLines(0);
    setShowClearConfirm(false);
    onClear?.();
  };

  const close = async () => {
    flushFinalPartialLine();
    await onClose?.();
  };

  const focusFind = () => {
    setFindOpen(true);
    setFilterPreset('custom');
    window.setTimeout(() => findInputRef.current?.focus(), 0);
  };

  const selectFilterPreset = (preset: OutputFilterPreset) => {
    setFilterPreset(preset);
    if (preset === 'custom') {
      window.setTimeout(() => findInputRef.current?.focus(), 0);
    }
  };

  const toggleFilterPanel = () => {
    if (isFindOpen) {
      setFindOpen(false);
      return;
    }
    setFindOpen(true);
    if (filterPreset === 'custom') {
      window.setTimeout(() => findInputRef.current?.focus(), 0);
    }
  };

  const closeFilterPanel = () => {
    setFindOpen(false);
    window.setTimeout(() => filterButtonRef.current?.focus(), 0);
  };

  const clearOutputFilter = () => {
    setFilterPreset('all');
    setOutputFilter('');
  };

  const copyCapturePath = async () => {
    if (!capturePath) return;
    if (capturePathCopyResetRef.current !== undefined) window.clearTimeout(capturePathCopyResetRef.current);
    try {
      if (!navigator.clipboard?.writeText) throw new Error('Clipboard access is unavailable.');
      await navigator.clipboard.writeText(capturePath);
      setCapturePathCopyStatus('copied');
    } catch {
      setCapturePathCopyStatus('error');
    }
    capturePathCopyResetRef.current = window.setTimeout(() => {
      setCapturePathCopyStatus('idle');
      capturePathCopyResetRef.current = undefined;
    }, 2_200);
  };

  useImperativeHandle(ref, () => ({
    toggleDisplayPause,
    requestClear: () => setShowClearConfirm(true),
    focusFind,
  }), [toggleDisplayPause]);

  const connectionCopy = {
    connected: { label: 'Connected', Icon: Check, detail: 'Port open · logging active' },
    reconnecting: { label: 'Reconnecting', Icon: LoaderCircle, detail: 'Trying to restore the port…' },
    disconnected: { label: 'Disconnected', Icon: WifiOff, detail: 'Logging is stopped' },
    error: { label: 'Connection error', Icon: AlertTriangle, detail: 'The serial port could not be opened' },
  }[connectionState];
  const captureCopy = {
    connected: { label: 'Raw capture active', detail: 'Incoming bytes are being saved locally.', Icon: Check },
    reconnecting: { label: 'Raw capture waiting', detail: 'Capture resumes when the port reconnects.', Icon: LoaderCircle },
    disconnected: { label: 'Raw capture disconnected', detail: 'The captured file is retained locally.', Icon: WifiOff },
    error: { label: 'Raw capture error', detail: 'No new bytes can be recorded until this session recovers.', Icon: AlertTriangle },
  }[connectionState];
  const StatusIcon = connectionCopy.Icon;
  const CaptureIcon = captureCopy.Icon;

  return (
    <section className="sd-monitor" aria-label={`${sessionName} live serial monitor`}>
      <header className="sd-monitor-header">
        <div className="sd-monitor-heading">
          <div className="sd-monitor-mark"><TerminalSquare size={19} /></div>
          <div><p className="sd-monitor-breadcrumb">Live terminal / Monitor</p><h1>{sessionName}</h1></div>
        </div>
        <div className="sd-monitor-header-actions">
          <button type="button" className="sd-monitor-secondary" onClick={reconnect} disabled={connectionState === 'connected' || isReconnecting}><RotateCw className={isReconnecting ? 'sd-spin' : ''} size={15} /> Reconnect</button>
          <button type="button" className="sd-monitor-danger-button" onClick={() => setShowDisconnectConfirm(true)} disabled={connectionState !== 'connected'}><PlugZap size={15} /> Disconnect</button>
          {onClose && <button className="sd-monitor-icon-button" type="button" onClick={() => void close()} aria-label="Close session"><X size={18} /></button>}
        </div>
      </header>

      <div className="sd-monitor-meta-row">
        <div className={`sd-monitor-status ${connectionState}`}><StatusIcon className={connectionState === 'reconnecting' ? 'sd-spin' : ''} size={14} /><strong>{connectionCopy.label}</strong><span>{connectionCopy.detail}</span></div>
        <div className="sd-monitor-chip"><span>{port}</span><i /> {baudRate.toLocaleString()} baud</div>
      </div>

      {nativeSession && <section className={`sd-capture-health ${connectionState}`} aria-label="Raw capture status">
        <div className="sd-capture-health-status">
          <CaptureIcon className={connectionState === 'reconnecting' ? 'sd-spin' : ''} size={16} aria-hidden="true" />
          <div><strong>{captureCopy.label}</strong><span>{captureCopy.detail}</span></div>
        </div>
        {capturePath && <div className="sd-capture-path">
          <code title={capturePath}>{capturePath}</code>
          <button className="sd-capture-copy" type="button" onClick={() => void copyCapturePath()} aria-label="Copy raw capture path" title="Copy raw capture path">
            {capturePathCopyStatus === 'copied' ? <Check size={14} /> : <Copy size={14} />}
            <span>{capturePathCopyStatus === 'copied' ? 'Copied' : capturePathCopyStatus === 'error' ? 'Copy failed' : 'Copy path'}</span>
          </button>
          <span className="sd-visually-hidden" role="status" aria-live="polite">{capturePathCopyStatus === 'copied' ? 'Raw capture path copied.' : capturePathCopyStatus === 'error' ? 'Could not copy the raw capture path.' : ''}</span>
        </div>}
      </section>}

      <MobileSharePanel sessionId={sessionId} nativeSession={nativeSession} sessionConnected={connectionState === 'connected'} />

      <article className="sd-terminal-card">
        <div className="sd-terminal-toolbar">
          <div className="sd-terminal-title"><span className="sd-terminal-led" /> Incoming data <em>{lines.length} lines in display</em></div>
          <div className="sd-terminal-controls">
            <label className="sd-autoscroll-toggle"><input type="checkbox" checked={autoScroll} onChange={(event) => setAutoScroll(event.target.checked)} /> Auto-scroll</label>
            {(!autoScroll || isPaused) && <button className="sd-monitor-secondary sd-go-to-end" type="button" onClick={goToEnd} title="Resume the display and jump to the newest data"><ChevronsDown size={15} /> Go to end</button>}
            <button className={`sd-monitor-secondary ${isPaused ? 'active' : ''}`} type="button" onClick={toggleDisplayPause}>{isPaused ? <CirclePlay size={15} /> : <CirclePause size={15} />}{isPaused ? 'Resume display' : 'Pause display'}</button>
            <button
              ref={filterButtonRef}
              className={`sd-monitor-icon-button ${isFindOpen || filterIsActive ? 'active' : ''}`}
              type="button"
              onClick={toggleFilterPanel}
              aria-controls={filterPanelId}
              aria-expanded={isFindOpen}
              aria-label={isFindOpen
                ? 'Hide live output filters'
                : filterIsActive
                  ? `Open live output filters. ${filteredLines.length} of ${visibleLines.length} displayed lines match.`
                  : 'Open live output filters'}
              title={isFindOpen ? 'Hide filter controls' : 'Filter live output'}
            >
              <Search size={16} />
            </button>
            <button className="sd-monitor-icon-button" type="button" onClick={() => setShowClearConfirm(true)} aria-label="Clear monitor display" title="Clear display"><Eraser size={16} /></button>
          </div>
        </div>
        <div className={`sd-terminal-logging ${nativeSession ? connectionState : 'preview'}`}>
          {nativeSession ? <CaptureIcon className={connectionState === 'reconnecting' ? 'sd-spin' : ''} size={13} /> : <Check size={13} />}
          {nativeSession ? captureCopy.label : 'Browser preview — no local capture'}{isPaused ? <strong> · display paused</strong> : ''}
        </div>
        {isFindOpen && (
          <section
            className="sd-terminal-find"
            id={filterPanelId}
            aria-label="Live output filters"
            onKeyDown={(event) => {
              if (event.key === 'Escape') closeFilterPanel();
            }}
          >
            <div className="sd-terminal-filter-row">
              <span className="sd-terminal-filter-label"><Search size={15} aria-hidden="true" /> Live filters</span>
              <div className="sd-terminal-filter-presets" role="group" aria-label="Filter preset">
                <button className={filterPreset === 'all' ? 'active' : ''} type="button" aria-pressed={filterPreset === 'all'} onClick={() => selectFilterPreset('all')}>All</button>
                <button className={filterPreset === 'errors' ? 'active error' : ''} type="button" aria-pressed={filterPreset === 'errors'} onClick={() => selectFilterPreset('errors')}>Errors</button>
                <button className={filterPreset === 'wifi' ? 'active wifi' : ''} type="button" aria-pressed={filterPreset === 'wifi'} onClick={() => selectFilterPreset('wifi')}>Wi-Fi</button>
                <button className={filterPreset === 'custom' ? 'active' : ''} type="button" aria-pressed={filterPreset === 'custom'} onClick={() => selectFilterPreset('custom')}>Custom</button>
              </div>
            </div>
            {filterPreset === 'custom' && (
              <div className="sd-terminal-filter-query">
                <label htmlFor={filterInputId}><Search size={15} aria-hidden="true" /><span className="sd-visually-hidden">Custom filter text</span></label>
                <input
                  ref={findInputRef}
                  id={filterInputId}
                  value={outputFilter}
                  onChange={(event) => setOutputFilter(event.target.value)}
                  placeholder="Find ERROR, sensor name, or any text"
                  aria-describedby={filterStatusId}
                  maxLength={256}
                />
                <span aria-hidden="true">{normalizedOutputFilter ? `${filteredLines.length} match${filteredLines.length === 1 ? '' : 'es'}` : 'Type to filter'}</span>
              </div>
            )}
            <div className="sd-terminal-filter-footer">
              <span id={filterStatusId} role="status" aria-live="polite">
                {filterIsActive
                  ? `${filteredLines.length} of ${visibleLines.length} displayed lines match. Raw capture is unchanged.`
                  : 'Choose a filter to focus the live display. Raw capture is unchanged.'}
              </span>
              <div className="sd-terminal-filter-actions">
                {filterIsActive && <button className="sd-terminal-filter-clear" type="button" onClick={clearOutputFilter}>Clear filter</button>}
                <button className="sd-terminal-filter-close" type="button" onClick={closeFilterPanel} aria-label="Hide live filter controls"><X size={15} /></button>
              </div>
            </div>
          </section>
        )}
        <div className={`sd-terminal-output ${showTimestamps ? '' : 'no-timestamps'}`} ref={outputRef} onScroll={(event) => {
          const target = event.currentTarget;
          setAutoScroll(target.scrollHeight - target.scrollTop - target.clientHeight < 32);
        }} role="log" aria-live={isPaused ? 'off' : 'polite'} aria-relevant="additions text" aria-label={showTimestamps ? 'Timestamped serial output' : 'Serial output'}>
          {!visibleLines.length && <div className="sd-terminal-empty"><TerminalSquare size={23} /><strong>Display cleared</strong><span>New incoming bytes will appear here. The active log is still recording.</span></div>}
          {visibleLines.length > 0 && !filteredLines.length && <div className="sd-terminal-empty"><Search size={23} /><strong>No matching output</strong><span>Try a different filter or clear the search.</span></div>}
          {filteredLines.map((line) => <div className={`sd-terminal-line ${line.kind ?? 'data'} ${filterIsActive ? 'is-filtered' : ''}`} key={line.id}>{showTimestamps && <time>{line.timestamp}</time>}<code><HighlightedOutput text={line.text} pattern={highlightPattern} /></code></div>)}
          {isPaused && <div className="sd-paused-note"><CirclePause size={15} /> Display paused. {waitingLines} {waitingLines === 1 ? 'new line is' : 'new lines are'} waiting.</div>}
        </div>
        <form className="sd-send-form" onSubmit={send}>
          <label htmlFor={sendInputId}>Send {sendMode === 'hex' ? 'hex bytes' : 'text'}</label>
          <div className="sd-send-row">
            <input
              id={sendInputId}
              value={outgoing}
              onChange={(event) => changeOutgoing(event.target.value)}
              onKeyDown={browseCommandHistory}
              aria-describedby={sendError ? `${sendHintId} ${sendErrorId}` : sendHintId}
              aria-invalid={sendError ? true : undefined}
              placeholder={connectionState === 'connected'
                ? sendMode === 'hex' ? '48 65 6C 6C 6F or 0x48, 0x65…' : 'Type a command…'
                : 'Reconnect to send a command'}
              disabled={connectionState !== 'connected' || isSending}
            />
            <label className="sd-send-mode" htmlFor={sendModeId}><span>Mode</span><select id={sendModeId} value={sendMode} onChange={(event) => changeSendMode(event.target.value as SendMode)} aria-describedby={sendHintId} disabled={connectionState !== 'connected' || isSending}><option value="text">Text</option><option value="hex">Hex</option></select></label>
            {sendMode === 'text' && <label className="sd-send-ending" htmlFor={sendEndingId}><span>Ending</span><select id={sendEndingId} value={sendLineEnding} onChange={(event) => setSendLineEnding(event.target.value as LineEnding)} aria-describedby={sendHintId} disabled={connectionState !== 'connected' || isSending}>{(['lf', 'crlf', 'cr', 'none'] as LineEnding[]).map((ending) => <option key={ending} value={ending}>{lineEndingLabel(ending)}</option>)}</select></label>}
            <button className="sd-primary-button" type="submit" disabled={!outgoing.trim() || isSending || connectionState !== 'connected'}>{isSending ? <LoaderCircle className="sd-spin" size={16} /> : <Send size={16} />} Send</button>
          </div>
          {sendError && <span className="sd-send-error" id={sendErrorId} role="alert">{sendError}</span>}
          <span id={sendHintId}>{nativeSession
            ? sendMode === 'hex'
              ? `Hex sends exact bytes with no text encoding or line ending · two-digit bytes separated by spaces or commas · ↑/↓ recalls up to ${MAX_COMMAND_HISTORY} hex sends`
              : `This session sends ${lineEndingLabel(sendLineEnding)} · ↑/↓ recalls up to ${MAX_COMMAND_HISTORY} text commands · raw capture stays active while display is paused`
            : sendMode === 'hex'
              ? 'Browser preview only · hex payloads are not transmitted · use two-digit bytes separated by spaces or commas'
              : `Browser preview only · ${lineEndingLabel(sendLineEnding)} selected for desktop sends · ↑/↓ recalls text commands`}</span>
        </form>
      </article>

      {showClearConfirm && <div className="sd-inline-confirm" role="alertdialog" aria-label="Confirm clear display"><div><AlertTriangle size={18} /><p><strong>Clear this display?</strong><span>This only clears the visible panel. The session log is unaffected.</span></p></div><div><button className="sd-monitor-secondary" type="button" onClick={() => setShowClearConfirm(false)}>Cancel</button><button className="sd-monitor-danger-button" type="button" onClick={clear}>Clear</button></div></div>}
      {showDisconnectConfirm && <div className="sd-inline-confirm" role="alertdialog" aria-label="Confirm disconnect"><div><PlugZap size={18} /><p><strong>Disconnect {sessionName}?</strong><span>The local log will be retained, but incoming data will stop.</span></p></div><div><button className="sd-monitor-secondary" type="button" onClick={() => setShowDisconnectConfirm(false)}>Cancel</button><button className="sd-monitor-danger-button" type="button" onClick={disconnect}>Disconnect</button></div></div>}
    </section>
  );
});
