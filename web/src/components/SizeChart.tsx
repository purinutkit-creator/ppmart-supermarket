// Size chart (ตารางเทียบขนาด) — shared by the online shop and the product editor preview.
import { useEffect } from 'react';

export type SizeChart = {
  title?: string | null;
  layout?: 'horizontal' | 'vertical';
  columns: string[]; // vertical only: header row
  rows: string[][]; // horizontal: [label, size1, size2, …] per size system · vertical: one row per size
  note?: string | null;
};

const isHorizontal = (c: SizeChart) => c.layout === 'horizontal';

/** Convert between layouts (keeps every value). */
export function transpose(c: SizeChart): SizeChart {
  if (isHorizontal(c)) {
    const n = Math.max(0, ...c.rows.map((r) => r.length - 1));
    return { ...c, layout: 'vertical', columns: c.rows.map((r) => r[0] ?? ''), rows: Array.from({ length: n }, (_, k) => c.rows.map((r) => r[k + 1] ?? '')) };
  }
  return { ...c, layout: 'horizontal', columns: [], rows: c.columns.map((h, j) => [h, ...c.rows.map((r) => r[j] ?? '')]) };
}

const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, ' ');

/**
 * Table in the "comparison chart" style: grey label column on the left, sizes across, scrolls sideways.
 * `highlight` (e.g. the selected size "42" or "M") marks the matching column / row.
 */
export function SizeChartTable({ chart, highlight }: { chart: SizeChart; highlight?: string | null }) {
  const h = highlight ? norm(highlight) : null;
  if (isHorizontal(chart)) {
    const width = Math.max(1, ...chart.rows.map((r) => r.length));
    const hiCol = h ? Array.from({ length: width }, (_, k) => k).find((k) => k > 0 && chart.rows.some((r) => norm(r[k] ?? '') === h)) : undefined;
    return (
      <div className="sc">
        <div className="sc-scroll">
          <table className="sc-table">
            <tbody>
              {chart.rows.map((r, i) => (
                <tr key={i}>
                  <th scope="row">{r[0]}</th>
                  {Array.from({ length: width - 1 }, (_, k) => <td key={k} className={hiCol === k + 1 ? 'hi' : ''}>{r[k + 1] ?? ''}</td>)}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {chart.note && <p className="sc-note">{chart.note}</p>}
      </div>
    );
  }
  const hiRow = h ? chart.rows.findIndex((r) => r.some((x) => norm(x ?? '') === h)) : -1;
  return (
    <div className="sc">
      <div className="sc-scroll">
        <table className="sc-table vertical">
          <thead><tr>{chart.columns.map((c, i) => <th key={i} scope="col">{c}</th>)}</tr></thead>
          <tbody>{chart.rows.map((r, i) => <tr key={i} className={i === hiRow ? 'hi' : ''}>{chart.columns.map((_, j) => <td key={j}>{r[j] ?? ''}</td>)}</tr>)}</tbody>
        </table>
      </div>
      {chart.note && <p className="sc-note">{chart.note}</p>}
    </div>
  );
}

/** Full-width pop-up with a centred title, like a brand size-comparison chart. */
export function SizeChartModal({ chart, highlight, fallbackTitle = 'ตารางเทียบขนาด', onClose }: { chart: SizeChart; highlight?: string | null; fallbackTitle?: string; onClose: () => void }) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', k);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { window.removeEventListener('keydown', k); document.body.style.overflow = prev; };
  }, [onClose]);
  return (
    <div className="sc-bg" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="sc-modal" role="dialog" aria-modal aria-label={chart.title || fallbackTitle}>
        <header><h2>{chart.title || fallbackTitle}</h2><button onClick={onClose} aria-label="ปิด">✕</button></header>
        <div className="sc-body"><SizeChartTable chart={chart} highlight={highlight} /></div>
      </div>
    </div>
  );
}
