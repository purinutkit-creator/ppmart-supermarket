// USB / Bluetooth HID barcode scanners act as fast keyboards. Detect bursts of keystrokes ending with Enter.
import { useEffect, useRef } from 'react';

export const scannerStatus = { lastScanAt: 0, lastCode: '', count: 0 };

export function useBarcodeScanner(onScan: (code: string) => void, enabled = true) {
  const cb = useRef(onScan);
  cb.current = onScan;
  useEffect(() => {
    if (!enabled) return;
    let buf = '';
    let last = 0;
    let fastCount = 0;
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      const inField = t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable) && !t.dataset.scanner;
      const now = performance.now();
      const gap = now - last;
      last = now;
      if (gap > 60) { buf = ''; fastCount = 0; }
      if (e.key === 'Enter') {
        if (buf.length >= 4 && fastCount >= buf.length - 2) {
          if (inField) { e.preventDefault(); (t as HTMLInputElement).value = ''; }
          const code = buf;
          buf = '';
          scannerStatus.lastScanAt = Date.now(); scannerStatus.lastCode = code; scannerStatus.count++;
          cb.current(code);
        }
        buf = ''; fastCount = 0;
        return;
      }
      if (e.key.length === 1) {
        if (inField && buf.length === 0 && gap > 60) { buf = e.key; fastCount = 0; return; }
        buf += e.key;
        if (gap < 35) fastCount++;
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [enabled]);
}
