import { exportCSV, exportXLSX, exportPDF, type Col } from '../lib/export';

export function ExportBar({ rows, cols, name, title }: { rows: any[]; cols: Col[]; name: string; title?: string }) {
  return (
    <div className="row">
      <button className="btn sm" onClick={() => exportCSV(rows, cols, name)}>⬇ CSV</button>
      <button className="btn sm" onClick={() => exportXLSX(rows, cols, name)}>⬇ Excel</button>
      <button className="btn sm" onClick={() => exportPDF(title ?? name, [{ rows, cols }])}>⬇ PDF</button>
    </div>
  );
}
