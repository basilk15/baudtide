import { useEffect, useMemo, useRef, useState } from 'react';
import { Check, ChevronDown, Copy, LoaderCircle, QrCode, RefreshCw, ShieldCheck, Smartphone, Users, Wifi } from 'lucide-react';
import { getMobileShareStatus, getMobileWorkspaceShareStatus, setMobileShareControl, startMobileShare, startMobileWorkspaceShare, stopMobileShare, stopMobileWorkspaceShare, type MobileShareInfo, type MobileWorkspaceShareInfo } from '../lib/serial';
import './mobile-share-panel.css';

const STATUS_REFRESH_MS = 5_000;
const QR_VERSION_SIX_SIZE = 41;
const QR_VERSION_SIX_DATA_CODEWORDS = 108;
const QR_VERSION_SIX_EC_CODEWORDS = 16;
const QR_VERSION_SIX_BLOCKS = 4;

type QrMatrix = boolean[][];

function gfMultiply(x: number, y: number) {
  let product = 0;
  let left = x;
  let right = y;
  while (right) {
    if (right & 1) product ^= left;
    left = (left << 1) ^ (left & 0x80 ? 0x11d : 0);
    right >>>= 1;
  }
  return product;
}

function reedSolomonGenerator(degree: number) {
  let polynomial = [1];
  let root = 1;
  for (let i = 0; i < degree; i += 1) {
    const next = new Array<number>(polynomial.length + 1).fill(0);
    for (let j = 0; j < polynomial.length; j += 1) {
      next[j] ^= polynomial[j];
      next[j + 1] ^= gfMultiply(polynomial[j], root);
    }
    polynomial = next;
    root = gfMultiply(root, 2);
  }
  return polynomial;
}

function reedSolomonRemainder(data: number[], degree: number) {
  const generator = reedSolomonGenerator(degree);
  const remainder = new Array<number>(degree).fill(0);
  for (const byte of data) {
    const factor = byte ^ remainder.shift()!;
    remainder.push(0);
    for (let index = 0; index < degree; index += 1) remainder[index] ^= gfMultiply(generator[index + 1], factor);
  }
  return remainder;
}

/**
 * A compact, local QR encoder for short pairing URLs. It intentionally fixes
 * the symbol to QR version 6 / error correction M: that holds up to 106 UTF-8
 * bytes, enough for the LAN URL plus the opaque, short-lived pairing token.
 * The normal copyable URL remains available should a future token outgrow it.
 */
function createPairingQr(value: string): QrMatrix | null {
  const bytes = [...new TextEncoder().encode(value)];
  if (bytes.length > 106) return null;
  const bits: number[] = [];
  const appendBits = (number: number, length: number) => {
    for (let shift = length - 1; shift >= 0; shift -= 1) bits.push((number >>> shift) & 1);
  };
  appendBits(0b0100, 4);
  appendBits(bytes.length, 8);
  bytes.forEach((byte) => appendBits(byte, 8));
  appendBits(0, Math.min(4, QR_VERSION_SIX_DATA_CODEWORDS * 8 - bits.length));
  while (bits.length % 8) bits.push(0);
  const data: number[] = [];
  for (let index = 0; index < bits.length; index += 8) data.push(bits.slice(index, index + 8).reduce((byte, bit) => (byte << 1) | bit, 0));
  for (let padIndex = 0; data.length < QR_VERSION_SIX_DATA_CODEWORDS; padIndex += 1) data.push(padIndex % 2 ? 0x11 : 0xec);

  const blockSize = QR_VERSION_SIX_DATA_CODEWORDS / QR_VERSION_SIX_BLOCKS;
  const dataBlocks = Array.from({ length: QR_VERSION_SIX_BLOCKS }, (_, index) => data.slice(index * blockSize, (index + 1) * blockSize));
  const ecBlocks = dataBlocks.map((block) => reedSolomonRemainder(block, QR_VERSION_SIX_EC_CODEWORDS));
  const codewords: number[] = [];
  for (let index = 0; index < blockSize; index += 1) dataBlocks.forEach((block) => codewords.push(block[index]));
  for (let index = 0; index < QR_VERSION_SIX_EC_CODEWORDS; index += 1) ecBlocks.forEach((block) => codewords.push(block[index]));

  const modules: Array<Array<boolean | null>> = Array.from({ length: QR_VERSION_SIX_SIZE }, () => new Array<boolean | null>(QR_VERSION_SIX_SIZE).fill(null));
  const set = (row: number, column: number, dark: boolean) => { modules[row][column] = dark; };
  const finder = (top: number, left: number) => {
    for (let row = -1; row <= 7; row += 1) for (let column = -1; column <= 7; column += 1) {
      if (top + row < 0 || top + row >= QR_VERSION_SIX_SIZE || left + column < 0 || left + column >= QR_VERSION_SIX_SIZE) continue;
      set(top + row, left + column, row >= 0 && row <= 6 && column >= 0 && column <= 6 && (row === 0 || row === 6 || column === 0 || column === 6 || (row >= 2 && row <= 4 && column >= 2 && column <= 4)));
    }
  };
  finder(0, 0); finder(QR_VERSION_SIX_SIZE - 7, 0); finder(0, QR_VERSION_SIX_SIZE - 7);
  // Version 6 has one non-overlapping alignment pattern, centered at 34,34.
  for (let row = -2; row <= 2; row += 1) for (let column = -2; column <= 2; column += 1) set(34 + row, 34 + column, Math.abs(row) === 2 || Math.abs(column) === 2 || (row === 0 && column === 0));
  for (let index = 8; index < QR_VERSION_SIX_SIZE - 8; index += 1) {
    if (modules[index][6] === null) set(index, 6, index % 2 === 0);
    if (modules[6][index] === null) set(6, index, index % 2 === 0);
  }
  // M-level / mask 0 format data, including its BCH and standard XOR mask.
  const format = 0x5412;
  for (let index = 0; index < 15; index += 1) {
    const dark = ((format >>> index) & 1) === 1;
    if (index < 6) set(index, 8, dark);
    else if (index < 8) set(index + 1, 8, dark);
    else set(QR_VERSION_SIX_SIZE - 15 + index, 8, dark);
    if (index < 8) set(8, QR_VERSION_SIX_SIZE - index - 1, dark);
    else if (index < 9) set(8, 15 - index, dark);
    else set(8, 15 - index - 1, dark);
  }
  set(QR_VERSION_SIX_SIZE - 8, 8, true);

  const dataBits = codewords.flatMap((byte) => Array.from({ length: 8 }, (_, index) => (byte >>> (7 - index)) & 1));
  let dataIndex = 0;
  let upward = true;
  for (let right = QR_VERSION_SIX_SIZE - 1; right > 0; right -= 2) {
    if (right === 6) right -= 1;
    for (let offset = 0; offset < QR_VERSION_SIX_SIZE; offset += 1) {
      const row = upward ? QR_VERSION_SIX_SIZE - 1 - offset : offset;
      for (let column = right; column >= right - 1; column -= 1) {
        if (modules[row][column] !== null) continue;
        const bit = dataBits[dataIndex++] ?? 0;
        set(row, column, ((row + column) % 2 === 0) ? bit === 0 : bit === 1);
      }
    }
    upward = !upward;
  }
  return modules.map((row) => row.map((cell) => cell === true));
}

function PairingQr({ value }: { value: string }) {
  const matrix = useMemo(() => createPairingQr(value), [value]);
  if (!matrix) return <QrCode size={74} aria-label="Copy the pairing link to open it on your phone" />;
  // Four blank modules around a symbol are the QR quiet zone. Keeping it in
  // the SVG (instead of relying only on CSS padding) makes camera scans more
  // reliable at small display sizes.
  return <svg viewBox="-4 -4 49 49" role="img" aria-label="Scan to open the BaudTide mobile companion"><rect x="-4" y="-4" width="49" height="49" fill="#fff" />{matrix.flatMap((row, rowIndex) => row.map((dark, columnIndex) => dark ? <rect key={`${rowIndex}-${columnIndex}`} x={columnIndex} y={rowIndex} width="1" height="1" /> : null))}</svg>;
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : 'Mobile sharing could not be updated.';
}

export type MobileShareNotice = {
  kind: 'error' | 'success';
  text: string;
};

export type MobileSharePanelState = {
  scope: 'terminal' | 'workspace';
  active: boolean;
  clientCount: number;
  controlEnabled: boolean;
  isWorking: boolean;
  notice: MobileShareNotice | null;
};

type MobileSharePanelProps = {
  sessionId?: string;
  nativeSession: boolean;
  sessionConnected: boolean;
  onStateChange?: (state: MobileSharePanelState) => void;
};

export function MobileSharePanel({ sessionId, nativeSession, sessionConnected, onStateChange }: MobileSharePanelProps) {
  const [share, setShare] = useState<MobileShareInfo | null>(null);
  const [isWorking, setWorking] = useState(false);
  const [message, setMessage] = useState<MobileShareNotice | null>(null);
  const [copied, setCopied] = useState(false);
  const workingRef = useRef(false);
  const canShare = Boolean(nativeSession && sessionId && sessionConnected);

  const startWorking = () => {
    if (workingRef.current) return false;
    workingRef.current = true;
    setWorking(true);
    return true;
  };

  const finishWorking = () => {
    workingRef.current = false;
    setWorking(false);
  };

  useEffect(() => {
    if (!nativeSession || !sessionId) return undefined;
    let disposed = false;
    const refresh = async (quiet = true) => {
      try {
        const status = await getMobileShareStatus(sessionId);
        if (!disposed && !workingRef.current) setShare(status.enabled ? status : null);
      } catch (error) {
        if (!disposed && !quiet) setMessage({ kind: 'error', text: errorMessage(error) });
      }
    };
    void refresh();
    const interval = window.setInterval(() => void refresh(), STATUS_REFRESH_MS);
    return () => {
      disposed = true;
      window.clearInterval(interval);
    };
  }, [nativeSession, sessionId]);

  useEffect(() => {
    if (sessionConnected) return;
    setShare(null);
  }, [sessionConnected]);

  useEffect(() => {
    onStateChange?.({
      scope: 'terminal',
      active: Boolean(share?.enabled),
      clientCount: share?.clientCount ?? 0,
      controlEnabled: share?.controlEnabled ?? false,
      isWorking,
      notice: message,
    });
  }, [isWorking, message, onStateChange, share]);

  const enable = async () => {
    if (!sessionId || !canShare || !startWorking()) return;
    setMessage(null);
    try {
      const next = await startMobileShare(sessionId);
      setShare(next.enabled ? next : null);
      if (!next.enabled) setMessage({ kind: 'error', text: 'Mobile sharing was not enabled for this session.' });
    } catch (error) {
      setMessage({ kind: 'error', text: errorMessage(error) });
    } finally {
      finishWorking();
    }
  };

  const revoke = async () => {
    if (!sessionId || !startWorking()) return;
    setMessage(null);
    setCopied(false);
    try {
      await stopMobileShare(sessionId);
      setShare(null);
    } catch (error) {
      setMessage({ kind: 'error', text: errorMessage(error) });
    } finally {
      finishWorking();
    }
  };

  const rotate = async () => {
    if (!sessionId || !share || !startWorking()) return;
    setMessage(null);
    setCopied(false);
    let previousLinkRevoked = false;
    try {
      // Stopping first invalidates the old bearer URL before the new QR code
      // is shown. `startMobileShare` creates a fresh, read-only share.
      await stopMobileShare(sessionId);
      previousLinkRevoked = true;
      setShare(null);
      const next = await startMobileShare(sessionId);
      if (!next.enabled) {
        setMessage({ kind: 'error', text: 'The previous link was revoked, but a replacement link could not be created.' });
        return;
      }
      setShare(next);
      setMessage({ kind: 'success', text: 'New mobile link created. The previous link no longer works; remote control is read-only by default.' });
    } catch (error) {
      if (previousLinkRevoked) setShare(null);
      setMessage({ kind: 'error', text: errorMessage(error) });
    } finally {
      finishWorking();
    }
  };

  const toggleControl = async () => {
    if (!sessionId || !share || !startWorking()) return;
    setMessage(null);
    try {
      const next = await setMobileShareControl(sessionId, !share.controlEnabled);
      setShare(next.enabled ? next : null);
    } catch (error) {
      setMessage({ kind: 'error', text: errorMessage(error) });
    } finally {
      finishWorking();
    }
  };

  const copyLink = async () => {
    if (!share?.url) return;
    try {
      await navigator.clipboard.writeText(share.url);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1_800);
    } catch {
      setMessage({ kind: 'error', text: 'Could not copy the link. Select and copy it manually.' });
    }
  };

  return (
    <details className="sd-mobile-share" aria-label="Mobile companion sharing">
      <summary className="sd-mobile-share-summary">
        <div className="sd-mobile-share-heading">
        <div className="sd-mobile-share-icon"><Smartphone size={18} /></div>
        <div><p>Terminal link</p><h2>Share this terminal</h2></div>
        {share && <span className="sd-mobile-share-live"><i /> Live</span>}
        {share && <span className={`sd-mobile-share-permission ${share.controlEnabled ? 'enabled' : 'readonly'}`}>{share.controlEnabled ? 'Control enabled' : 'Read-only'}</span>}
        </div>
        <ChevronDown className="sd-mobile-share-chevron" size={17} aria-hidden="true" />
      </summary>
      <div className="sd-mobile-share-content">

      {!nativeSession && <div className="sd-mobile-share-preview"><QrCode size={17} /><span>Available in the desktop app.</span></div>}

      {nativeSession && !sessionConnected && <div className="sd-mobile-share-preview"><Wifi size={17} /><span>Connect this terminal to create a link.</span></div>}

      {canShare && !share && <div className="sd-mobile-share-start">
        <p>Share this feed over the same Wi-Fi. New links start read-only.</p>
        <button className="sd-primary-button" type="button" onClick={() => void enable()} disabled={isWorking}>
          {isWorking ? <LoaderCircle className="sd-spin" size={16} /> : <QrCode size={16} />} Create mobile link
        </button>
      </div>}

      {share && <div className="sd-mobile-share-active">
        <div className="sd-mobile-share-qr">
          <PairingQr value={share.url} />
        </div>
        <div className="sd-mobile-share-details">
          <p className="sd-mobile-share-instruction">Scan to open the live view, or copy the link below.</p>
          <div className="sd-mobile-share-link"><code title={share.url}>{share.url}</code><button type="button" onClick={() => void copyLink()} title="Copy mobile link" aria-label="Copy mobile link" disabled={isWorking}>{copied ? <Check size={15} /> : <Copy size={15} />}</button></div>
          <div className="sd-mobile-share-metrics"><span><Users size={14} /> {share.clientCount} {share.clientCount === 1 ? 'phone' : 'phones'}</span><span title="Local network address"><Wifi size={14} /> {share.host}:{share.port}</span></div>
          <div className={`sd-mobile-share-control ${share.controlEnabled ? 'enabled' : 'readonly'}`}>
            <ShieldCheck size={15} />
            <div><strong>{share.controlEnabled ? 'Control enabled' : 'Read-only'}</strong><span>{share.controlEnabled ? 'Phone can send serial commands.' : 'Phone can view and download.'}</span></div>
            <button type="button" onClick={() => void toggleControl()} disabled={isWorking} aria-label={share.controlEnabled ? 'Disable remote control' : 'Enable remote control'} title={share.controlEnabled ? 'Disable remote control' : 'Enable remote control'} aria-pressed={share.controlEnabled}>{isWorking ? <LoaderCircle className="sd-spin" size={14} /> : null}{share.controlEnabled ? 'Disable' : 'Enable'}</button>
          </div>
          <div className="sd-mobile-share-actions">
            <button className="sd-mobile-share-rotate" type="button" onClick={() => void rotate()} disabled={isWorking} title="Create a new read-only link and invalidate the current one" aria-label="Rotate mobile link">{isWorking ? <LoaderCircle className="sd-spin" size={14} /> : <RefreshCw size={14} />} {isWorking ? 'Rotating…' : 'Rotate'}</button>
            <button className="sd-mobile-share-revoke" type="button" onClick={() => void revoke()} disabled={isWorking} aria-label="Revoke mobile link" title="Revoke mobile link">{isWorking ? <LoaderCircle className="sd-spin" size={14} /> : null} {isWorking ? 'Revoking…' : 'Revoke'}</button>
          </div>
        </div>
      </div>}

      <details className="sd-mobile-share-safety">
        <summary><ShieldCheck size={15} /><strong>{share?.controlEnabled ? 'Control enabled · local network only' : 'Read-only by default · local network only'}</strong><ChevronDown className="sd-mobile-share-safety-chevron" size={15} aria-hidden="true" /></summary>
        <p>{share?.controlEnabled ? 'Anyone with this link can send up to 4 KiB to the serial session. Disable control or revoke the link at any time.' : 'The phone can view and download the log, but cannot write to the serial session. Enable control only when needed.'} The link ends when the serial session disconnects.</p>
      </details>
      {message && <p className={`sd-mobile-share-message ${message.kind}`} role="status">{message.text}</p>}
      </div>
    </details>
  );
}

type WorkspaceMobileSharePanelProps = {
  nativeEnabled: boolean;
  activeSessionCount: number;
  onStateChange?: (state: MobileSharePanelState) => void;
};

/** One workspace-scoped link for all native sessions active when sharing starts. */
export function WorkspaceMobileSharePanel({ nativeEnabled, activeSessionCount, onStateChange }: WorkspaceMobileSharePanelProps) {
  const [share, setShare] = useState<MobileWorkspaceShareInfo | null>(null);
  const [isWorking, setWorking] = useState(false);
  const [message, setMessage] = useState<MobileShareNotice | null>(null);
  const [copied, setCopied] = useState(false);
  const workingRef = useRef(false);
  const canShare = nativeEnabled && activeSessionCount > 0;

  const startWorking = () => {
    if (workingRef.current) return false;
    workingRef.current = true;
    setWorking(true);
    return true;
  };

  const finishWorking = () => {
    workingRef.current = false;
    setWorking(false);
  };

  useEffect(() => {
    if (!nativeEnabled) return undefined;
    let disposed = false;
    const refresh = async (quiet = true) => {
      try {
        const status = await getMobileWorkspaceShareStatus();
        if (!disposed && !workingRef.current) setShare(status.enabled ? status : null);
      } catch (error) {
        if (!disposed && !quiet) setMessage({ kind: 'error', text: errorMessage(error) });
      }
    };
    void refresh();
    const interval = window.setInterval(() => void refresh(), STATUS_REFRESH_MS);
    return () => {
      disposed = true;
      window.clearInterval(interval);
    };
  }, [nativeEnabled]);

  useEffect(() => {
    onStateChange?.({
      scope: 'workspace',
      active: Boolean(share?.enabled),
      clientCount: share?.clientCount ?? 0,
      controlEnabled: false,
      isWorking,
      notice: message,
    });
  }, [isWorking, message, onStateChange, share]);

  const enable = async () => {
    if (!canShare || !startWorking()) return;
    setMessage(null);
    try {
      const next = await startMobileWorkspaceShare();
      setShare(next.enabled ? next : null);
      if (!next.enabled) setMessage({ kind: 'error', text: 'No active serial sessions were available for the workspace link.' });
    } catch (error) {
      setMessage({ kind: 'error', text: errorMessage(error) });
    } finally {
      finishWorking();
    }
  };

  const revoke = async () => {
    if (!startWorking()) return;
    setMessage(null);
    setCopied(false);
    try {
      await stopMobileWorkspaceShare();
      setShare(null);
    } catch (error) {
      setMessage({ kind: 'error', text: errorMessage(error) });
    } finally {
      finishWorking();
    }
  };

  const rotate = async () => {
    if (!share || !startWorking()) return;
    setMessage(null);
    setCopied(false);
    let previousLinkRevoked = false;
    try {
      // The workspace server receives a new token when it is started again,
      // so phones holding the old URL cannot reconnect.
      await stopMobileWorkspaceShare();
      previousLinkRevoked = true;
      setShare(null);
      const next = await startMobileWorkspaceShare();
      if (!next.enabled) {
        setMessage({ kind: 'error', text: 'The previous workspace link was revoked, but a replacement link could not be created.' });
        return;
      }
      setShare(next);
      setMessage({ kind: 'success', text: 'New workspace link created. The previous link no longer works.' });
    } catch (error) {
      if (previousLinkRevoked) setShare(null);
      setMessage({ kind: 'error', text: errorMessage(error) });
    } finally {
      finishWorking();
    }
  };

  const copyLink = async () => {
    if (!share?.url) return;
    try {
      await navigator.clipboard.writeText(share.url);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1_800);
    } catch {
      setMessage({ kind: 'error', text: 'Could not copy the link. Select and copy it manually.' });
    }
  };

  return (
    <aside className="sd-mobile-workspace-share" aria-label="Mobile workspace dashboard sharing">
      <div className="sd-mobile-workspace-heading">
        <div className="sd-mobile-share-icon"><Smartphone size={18} /></div>
        <div><h2>Share all active terminals</h2><span>{activeSessionCount} active · one phone view</span></div>
        {share && <span className="sd-mobile-share-live"><i /> Live</span>}
      </div>

      {!nativeEnabled && <div className="sd-mobile-share-preview"><QrCode size={17} /><span>Available in the desktop app.</span></div>}

      {nativeEnabled && !share && !activeSessionCount && <div className="sd-mobile-share-preview"><Wifi size={17} /><span>Open a serial terminal to create a link.</span></div>}

      {canShare && !share && <div className="sd-mobile-workspace-start">
        <p>One local link shares the {activeSessionCount} active terminal stream{activeSessionCount === 1 ? '' : 's'}.</p>
        <button className="sd-primary-button" type="button" onClick={() => void enable()} disabled={isWorking}>
          {isWorking ? <LoaderCircle className="sd-spin" size={16} /> : <QrCode size={16} />} Create workspace link
        </button>
      </div>}

      {share && <div className="sd-mobile-workspace-active">
        <div className="sd-mobile-share-qr"><PairingQr value={share.url} /></div>
        <div className="sd-mobile-share-details">
          <p className="sd-mobile-share-instruction">Scan to open the workspace view, or copy the link below.</p>
          <div className="sd-mobile-share-link"><code title={share.url}>{share.url}</code><button type="button" onClick={() => void copyLink()} title="Copy workspace mobile link" aria-label="Copy workspace mobile link" disabled={isWorking}>{copied ? <Check size={15} /> : <Copy size={15} />}</button></div>
          <div className="sd-mobile-share-metrics"><span><Users size={14} /> {share.clientCount} {share.clientCount === 1 ? 'phone' : 'phones'}</span><span title="Local network address"><Wifi size={14} /> {share.host}:{share.port}</span></div>
          <div className="sd-mobile-share-actions">
            <button className="sd-mobile-share-rotate" type="button" onClick={() => void rotate()} disabled={isWorking} title="Create a new workspace link and invalidate the current one" aria-label="Rotate workspace link">{isWorking ? <LoaderCircle className="sd-spin" size={14} /> : <RefreshCw size={14} />} {isWorking ? 'Rotating…' : 'Rotate'}</button>
            <button className="sd-mobile-share-revoke" type="button" onClick={() => void revoke()} disabled={isWorking} aria-label="Revoke workspace link" title="Revoke workspace link">{isWorking ? <LoaderCircle className="sd-spin" size={14} /> : null} {isWorking ? 'Revoking…' : 'Revoke'}</button>
          </div>
        </div>
      </div>}

      <details className="sd-mobile-share-safety">
        <summary><ShieldCheck size={15} /><strong>Read-only · local network only</strong><ChevronDown className="sd-mobile-share-safety-chevron" size={15} aria-hidden="true" /></summary>
        <p>The phone can view the sessions included in this link. Serial commands and arbitrary files are not exposed. The link ends when the serial session disconnects.</p>
      </details>
      {message && <p className={`sd-mobile-share-message ${message.kind}`} role="status">{message.text}</p>}
    </aside>
  );
}
