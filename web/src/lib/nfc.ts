// Card tap support.
// 1) USB/serial RFID & NFC readers (most POS card readers) act as keyboards: they "type" the card UID + Enter,
//    so any focused input captures them — no special API needed.
// 2) Web NFC (Chrome on Android): reads the tag serial number directly on tablets/phones.
export const webNfcSupported = typeof window !== 'undefined' && 'NDEFReader' in window;

/** Normalise an NFC serial ("04:a2:3b:…") to uppercase hex without separators. */
export const normalizeUid = (s: string) => s.replace(/[^0-9a-f]/gi, '').toUpperCase();

export async function readNfcOnce(signal: AbortSignal): Promise<string> {
  if (!webNfcSupported) throw new Error('อุปกรณ์นี้ไม่รองรับ Web NFC');
  const reader = new (window as any).NDEFReader();
  await reader.scan({ signal });
  return new Promise((resolve, reject) => {
    reader.onreading = (e: any) => resolve(normalizeUid(e.serialNumber || ''));
    reader.onreadingerror = () => reject(new Error('อ่านบัตรไม่สำเร็จ ลองแตะใหม่'));
    signal.addEventListener('abort', () => reject(new Error('cancelled')));
  });
}
