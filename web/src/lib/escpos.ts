// ESC/POS command builder (raster bitmap printing, cut, feed, cash drawer).

export const ESC = 0x1b, GS = 0x1d;

export class EscPos {
  private parts: number[] = [];
  init() { this.parts.push(ESC, 0x40); return this; }
  align(a: 0 | 1 | 2) { this.parts.push(ESC, 0x61, a); return this; }
  /** Feed n lines */
  feed(n: number) { this.parts.push(ESC, 0x64, Math.max(0, Math.min(255, n))); return this; }
  /** Set line spacing in dots (affects feed distance) */
  lineSpacing(dots: number) { this.parts.push(ESC, 0x33, Math.max(0, Math.min(255, dots))); return this; }
  cut(kind: 'full' | 'partial' | 'none') {
    if (kind === 'full') this.parts.push(GS, 0x56, 0x41, 0x00); // GS V 65 0: feed to cut position + full cut
    else if (kind === 'partial') this.parts.push(GS, 0x56, 0x42, 0x00); // GS V 66 0: feed + partial cut
    return this;
  }
  /** Cash drawer pulse: ESC p m t1 t2 (pin 2 or 5) */
  drawer(pin: 0 | 1 = 0, onMs = 50, offMs = 500) { this.parts.push(ESC, 0x70, pin, Math.min(255, onMs / 2), Math.min(255, offMs / 2)); return this; }
  beep() { this.parts.push(ESC, 0x42, 0x02, 0x02); return this; }
  text(s: string) { for (const b of new TextEncoder().encode(s)) this.parts.push(b); return this; }
  raw(bytes: ArrayLike<number>) { for (let i = 0; i < bytes.length; i++) this.parts.push(bytes[i]); return this; }

  /**
   * GS v 0 raster image. Canvas must already be black/white. Sent in bands so printers with
   * small input buffers can keep up.
   */
  raster(canvas: HTMLCanvasElement, bandHeight = 128) {
    const w = canvas.width, h = canvas.height;
    const bytesPerRow = Math.ceil(w / 8);
    const data = canvas.getContext('2d', { willReadFrequently: true })!.getImageData(0, 0, w, h).data;
    for (let y0 = 0; y0 < h; y0 += bandHeight) {
      const bh = Math.min(bandHeight, h - y0);
      this.parts.push(GS, 0x76, 0x30, 0x00, bytesPerRow & 0xff, (bytesPerRow >> 8) & 0xff, bh & 0xff, (bh >> 8) & 0xff);
      for (let y = y0; y < y0 + bh; y++) {
        for (let bx = 0; bx < bytesPerRow; bx++) {
          let byte = 0;
          for (let bit = 0; bit < 8; bit++) {
            const x = bx * 8 + bit;
            if (x < w) {
              const i = (y * w + x) * 4;
              const dark = data[i] < 128 && data[i + 3] > 0;
              if (dark) byte |= 0x80 >> bit;
            }
          }
          this.parts.push(byte);
        }
      }
    }
    return this;
  }

  bytes() { return new Uint8Array(this.parts); }
}

export function receiptJob(canvas: HTMLCanvasElement, opts: { cut: 'full' | 'partial' | 'none'; feedLines: number; openDrawer?: boolean }) {
  const e = new EscPos().init();
  if (opts.openDrawer) e.drawer(0);
  e.align(0).raster(canvas).feed(opts.feedLines).cut(opts.cut);
  return e.bytes();
}
