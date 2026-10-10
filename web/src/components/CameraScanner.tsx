import { useEffect, useRef, useState } from 'react';
import { BrowserMultiFormatReader, type IScannerControls } from '@zxing/browser';
import { Modal } from './ui';

/** Camera barcode/QR scanner (EAN-13, EAN-8, UPC-A/E, Code 128, QR …). Uses native BarcodeDetector when present via ZXing fallback. */
export function CameraScanner({ onScan, onClose }: { onScan: (code: string) => void; onClose: () => void }) {
  const video = useRef<HTMLVideoElement>(null);
  const [err, setErr] = useState('');
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [deviceId, setDeviceId] = useState<string | undefined>(() => localStorage.getItem('ppmart.camera') || undefined);

  useEffect(() => {
    let controls: IScannerControls | null = null;
    let stopped = false;
    const reader = new BrowserMultiFormatReader();
    (async () => {
      try {
        const list = await BrowserMultiFormatReader.listVideoInputDevices();
        setDevices(list);
        const id = deviceId ?? list.find((d) => /back|rear|environment/i.test(d.label))?.deviceId;
        controls = await reader.decodeFromVideoDevice(id, video.current!, (res) => {
          if (res && !stopped) { stopped = true; navigator.vibrate?.(60); onScan(res.getText()); }
        });
      } catch (e: any) { setErr(e?.message || 'ไม่สามารถเปิดกล้องได้ (ต้องอนุญาตการใช้กล้องและใช้ HTTPS)'); }
    })();
    return () => { stopped = true; controls?.stop(); };
  }, [deviceId, onScan]);

  return (
    <Modal title="📷 สแกนด้วยกล้อง" onClose={onClose} width={520}>
      {devices.length > 1 && (
        <select className="in" value={deviceId ?? ''} onChange={(e) => { setDeviceId(e.target.value); localStorage.setItem('ppmart.camera', e.target.value); }} style={{ marginBottom: 8 }}>
          {devices.map((d) => <option key={d.deviceId} value={d.deviceId}>{d.label || d.deviceId}</option>)}
        </select>
      )}
      <video ref={video} style={{ width: '100%', borderRadius: 12, background: '#000' }} muted playsInline />
      {err && <p className="err">{err}</p>}
      <p className="muted small">รองรับ EAN-13, EAN-8, UPC, Code 128 และ QR Code</p>
    </Modal>
  );
}
