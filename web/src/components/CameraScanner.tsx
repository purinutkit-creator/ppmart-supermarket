import { useEffect, useRef, useState } from 'react';
import { BrowserMultiFormatReader, type IScannerControls } from '@zxing/browser';
import { BarcodeFormat, DecodeHintType } from '@zxing/library';
import { Modal } from './ui';

const CAMERA_KEY = 'ppmart.camera';
const NATIVE_FORMATS = ['ean_13', 'ean_8', 'upc_a', 'upc_e', 'code_128', 'code_39', 'code_93', 'itf', 'codabar', 'qr_code'];
const ZXING_FORMATS = [BarcodeFormat.EAN_13, BarcodeFormat.EAN_8, BarcodeFormat.UPC_A, BarcodeFormat.UPC_E, BarcodeFormat.CODE_128,
  BarcodeFormat.CODE_39, BarcodeFormat.CODE_93, BarcodeFormat.ITF, BarcodeFormat.CODABAR, BarcodeFormat.QR_CODE];

function describe(e: any): string {
  switch (e?.name) {
    case 'NotAllowedError': return 'ไม่ได้รับอนุญาตให้ใช้กล้อง — กดไอคอนกุญแจ/กล้องที่แถบที่อยู่ของเบราว์เซอร์ แล้วเลือก “อนุญาต” จากนั้นเปิดใหม่';
    case 'NotFoundError': case 'OverconstrainedError': return 'ไม่พบกล้องบนอุปกรณ์นี้';
    case 'NotReadableError': case 'AbortError': return 'กล้องกำลังถูกใช้งานโดยโปรแกรม/แท็บอื่น — ปิดโปรแกรมนั้นแล้วลองใหม่';
    case 'SecurityError': return 'เบราว์เซอร์ไม่อนุญาตให้ใช้กล้องบนหน้านี้ (ต้องเปิดผ่าน HTTPS)';
    default: return e?.message || 'ไม่สามารถเปิดกล้องได้';
  }
}

/**
 * Camera barcode / QR scanner (EAN-13, EAN-8, UPC-A/E, Code 128/39/93, ITF, Codabar, QR).
 * Uses the browser's native BarcodeDetector when it supports these formats (Chrome on Android/macOS/ChromeOS),
 * otherwise ZXing. The camera opens once per selected device at HD resolution with continuous autofocus.
 */
export function CameraScanner({ onScan, onClose }: { onScan: (code: string) => void; onClose: () => void }) {
  const video = useRef<HTMLVideoElement>(null);
  const onScanRef = useRef(onScan);
  onScanRef.current = onScan; // never restart the camera just because the parent re-rendered
  const trackRef = useRef<MediaStreamTrack | null>(null);
  const [err, setErr] = useState('');
  const [status, setStatus] = useState<'starting' | 'scanning'>('starting');
  const [engine, setEngine] = useState('');
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [deviceId, setDeviceId] = useState<string | undefined>(() => localStorage.getItem(CAMERA_KEY) || undefined);
  const [torch, setTorch] = useState<boolean | null>(null); // null = not supported

  useEffect(() => {
    let cancelled = false;
    let stream: MediaStream | null = null;
    let zx: IScannerControls | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const cleanup = () => {
      clearTimeout(timer);
      try { zx?.stop(); } catch { /* ignore */ }
      stream?.getTracks().forEach((t) => t.stop());
      trackRef.current = null;
    };
    const done = (text: string) => {
      if (cancelled || !text) return;
      cancelled = true;
      cleanup();
      navigator.vibrate?.(80);
      onScanRef.current(text.trim());
    };

    (async () => {
      setErr(''); setStatus('starting'); setTorch(null);
      if (!window.isSecureContext) throw Object.assign(new Error(''), { name: 'SecurityError' });
      if (!navigator.mediaDevices?.getUserMedia) throw new Error('เบราว์เซอร์นี้ไม่รองรับการใช้กล้อง');
      const size = { width: { ideal: 1920 }, height: { ideal: 1080 } };
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: deviceId ? { deviceId: { exact: deviceId }, ...size } : { facingMode: { ideal: 'environment' }, ...size } });
      } catch (e: any) {
        if (deviceId && (e?.name === 'OverconstrainedError' || e?.name === 'NotFoundError')) {
          // remembered camera no longer exists on this machine -> fall back to the default camera
          localStorage.removeItem(CAMERA_KEY);
          if (!cancelled) setDeviceId(undefined);
          return;
        }
        throw e;
      }
      if (cancelled) { stream.getTracks().forEach((t) => t.stop()); return; }

      const track = stream.getVideoTracks()[0];
      trackRef.current = track;
      const caps: any = (track as any).getCapabilities?.() ?? {};
      if (caps.focusMode?.includes?.('continuous')) track.applyConstraints({ advanced: [{ focusMode: 'continuous' } as any] }).catch(() => {});
      if (caps.torch) setTorch(false);
      navigator.mediaDevices.enumerateDevices().then((l) => !cancelled && setDevices(l.filter((d) => d.kind === 'videoinput'))).catch(() => {});

      const v = video.current!;
      v.srcObject = stream;
      v.setAttribute('playsinline', 'true');
      await v.play().catch(() => {});
      if (cancelled) return;

      // Engine 1: native BarcodeDetector
      const BD = (window as any).BarcodeDetector;
      let detector: any = null;
      if (BD?.getSupportedFormats) {
        const supported: string[] = await BD.getSupportedFormats().catch(() => []);
        const formats = NATIVE_FORMATS.filter((f) => supported.includes(f));
        if (formats.includes('ean_13') || formats.includes('code_128')) detector = new BD({ formats });
      }
      if (detector) {
        setEngine('BarcodeDetector'); setStatus('scanning');
        const tick = async () => {
          if (cancelled) return;
          try {
            if (v.readyState >= 2) {
              const found = await detector.detect(v);
              if (found?.[0]?.rawValue) return done(found[0].rawValue);
            }
          } catch { /* frame not ready */ }
          timer = setTimeout(tick, 100);
        };
        tick();
        return;
      }

      // Engine 2: ZXing (Windows/Linux Chrome, Firefox, Safari)
      const hints = new Map<DecodeHintType, any>([[DecodeHintType.POSSIBLE_FORMATS, ZXING_FORMATS], [DecodeHintType.TRY_HARDER, true]]);
      const reader = new BrowserMultiFormatReader(hints, { delayBetweenScanAttempts: 80, delayBetweenScanSuccess: 500 });
      setEngine('ZXing'); setStatus('scanning');
      zx = await reader.decodeFromStream(stream, v, (res) => { if (res) done(res.getText()); });
      if (cancelled) { try { zx.stop(); } catch { /* ignore */ } }
    })().catch((e) => { if (!cancelled) setErr(describe(e)); });

    return () => { cancelled = true; cleanup(); };
  }, [deviceId]);

  /** Fallback: take a full-resolution photo (autofocus) and decode it — very reliable on phones/tablets. */
  const decodePhoto = async (file?: File) => {
    if (!file) return;
    setErr('');
    const url = URL.createObjectURL(file);
    try {
      const BD = (window as any).BarcodeDetector;
      if (BD) {
        try {
          const supported: string[] = await BD.getSupportedFormats();
          const formats = NATIVE_FORMATS.filter((f) => supported.includes(f));
          if (formats.length) {
            const found = await new BD({ formats }).detect(await createImageBitmap(file));
            if (found?.[0]?.rawValue) { onScanRef.current(found[0].rawValue.trim()); return; }
          }
        } catch { /* fall back to ZXing */ }
      }
      const hints = new Map<DecodeHintType, any>([[DecodeHintType.POSSIBLE_FORMATS, ZXING_FORMATS], [DecodeHintType.TRY_HARDER, true]]);
      const res = await new BrowserMultiFormatReader(hints).decodeFromImageUrl(url);
      onScanRef.current(res.getText().trim());
    } catch {
      setErr('อ่านบาร์โค้ดจากรูปไม่ได้ — ถ่ายให้บาร์โค้ดเต็มกรอบ ชัด ไม่สะท้อนแสง แล้วลองใหม่');
    } finally { URL.revokeObjectURL(url); }
  };

  const toggleTorch = async () => {
    const t = trackRef.current;
    if (!t || torch == null) return;
    try { await t.applyConstraints({ advanced: [{ torch: !torch } as any] }); setTorch(!torch); } catch { /* ignore */ }
  };

  return (
    <Modal title="📷 สแกนด้วยกล้อง" onClose={onClose} width={560}>
      {devices.length > 1 && (
        <select className="in" value={deviceId ?? ''} style={{ marginBottom: 8 }}
          onChange={(e) => { const id = e.target.value || undefined; setDeviceId(id); if (id) localStorage.setItem(CAMERA_KEY, id); else localStorage.removeItem(CAMERA_KEY); }}>
          <option value="">กล้องหลัก (อัตโนมัติ)</option>
          {devices.map((d, i) => <option key={d.deviceId || i} value={d.deviceId}>{d.label || `กล้อง ${i + 1}`}</option>)}
        </select>
      )}
      <div style={{ position: 'relative', borderRadius: 12, overflow: 'hidden', background: '#000' }}>
        <video ref={video} style={{ width: '100%', display: 'block' }} muted playsInline autoPlay />
        {!err && <div style={{ position: 'absolute', left: '10%', right: '10%', top: '30%', bottom: '30%', border: '3px solid rgba(34,197,94,.9)', borderRadius: 10, boxShadow: '0 0 0 9999px rgba(0,0,0,.25)' }}>
          <div style={{ position: 'absolute', left: 0, right: 0, top: '50%', height: 2, background: 'rgba(239,68,68,.8)' }} />
        </div>}
      </div>
      {err ? <p className="err">{err}</p> : <p className="small muted">{status === 'starting' ? 'กำลังเปิดกล้อง…' : 'วางบาร์โค้ดให้อยู่ในกรอบ ห่างประมาณ 10–20 ซม. ให้แสงสว่างพอ'}</p>}
      <div className="row between">
        <span className="xs muted">รองรับ EAN-13, EAN-8, UPC, Code 128/39, ITF และ QR Code{engine ? ` · ${engine}` : ''}</span>
        <div className="row">
          {torch != null && <button className="btn sm" onClick={toggleTorch}>{torch ? '🔦 ปิดไฟ' : '🔦 เปิดไฟ'}</button>}
          <label className="btn sm">📸 ถ่ายรูปบาร์โค้ดแทน<input type="file" accept="image/*" capture="environment" hidden data-photo-scan onChange={(e) => { decodePhoto(e.target.files?.[0]); e.target.value = ''; }} /></label>
        </div>
      </div>
    </Modal>
  );
}
