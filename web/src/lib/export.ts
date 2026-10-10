import * as XLSX from 'xlsx';

export interface Col<T = any> { key: string; label: string; get?: (r: T) => any }

const cell = (c: Col, r: any) => (c.get ? c.get(r) : r[c.key]);

function download(blob: Blob, name: string) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

export function exportCSV(rows: any[], cols: Col[], name: string) {
  const esc = (v: any) => { const s = v == null ? '' : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const csv = [cols.map((c) => esc(c.label)).join(','), ...rows.map((r) => cols.map((c) => esc(cell(c, r))).join(','))].join('\r\n');
  download(new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' }), name + '.csv');
}

export function exportXLSX(rows: any[], cols: Col[], name: string, sheet = 'Report') {
  const data = [cols.map((c) => c.label), ...rows.map((r) => cols.map((c) => cell(c, r)))];
  const ws = XLSX.utils.aoa_to_sheet(data);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, sheet.slice(0, 31));
  XLSX.writeFile(wb, name + '.xlsx');
}

/** PDF export through the browser's print engine (choose "Save as PDF"); Thai fonts render correctly. */
export function exportPDF(title: string, sections: { title?: string; rows: any[]; cols: Col[] }[], font = 'Sarabun') {
  const w = window.open('', '_blank');
  if (!w) return;
  const esc = (s: any) => String(s ?? '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]!));
  const body = sections.map((s) => `${s.title ? `<h3>${esc(s.title)}</h3>` : ''}<table><thead><tr>${s.cols.map((c) => `<th>${esc(c.label)}</th>`).join('')}</tr></thead><tbody>${s.rows.map((r) => `<tr>${s.cols.map((c) => `<td>${esc(cell(c, r))}</td>`).join('')}</tr>`).join('')}</tbody></table>`).join('');
  w.document.write(`<html><head><meta charset="utf-8"><title>${esc(title)}</title><link href="https://fonts.googleapis.com/css2?family=${encodeURIComponent(font)}:wght@400;700&display=swap" rel="stylesheet">
<style>body{font-family:"${font}",sans-serif;font-size:11px;margin:16px}h1{font-size:18px}table{width:100%;border-collapse:collapse;margin-bottom:16px}th,td{border:1px solid #ccc;padding:4px 6px;text-align:left}th{background:#f1f5f9}@page{size:A4;margin:12mm}</style></head>
<body><h1>${esc(title)}</h1><div>${new Date().toLocaleString('th-TH')}</div>${body}<script>document.fonts.ready.then(()=>setTimeout(()=>print(),300))</script></body></html>`);
  w.document.close();
}

export async function readSheet(file: File): Promise<Record<string, any>[]> {
  const buf = await file.arrayBuffer();
  const wb = XLSX.read(buf, { type: 'array' });
  return XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { defval: '' });
}

