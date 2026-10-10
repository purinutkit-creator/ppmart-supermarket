export { fmtMoney, fmtNum, fmtQty, toSatang } from '../../../shared/money';
export const fmtDate = (d: string | Date | null | undefined, withTime = true) =>
  d ? new Date(d).toLocaleString('th-TH', { day: '2-digit', month: '2-digit', year: 'numeric', ...(withTime ? { hour: '2-digit', minute: '2-digit' } : {}) }) : '-';
export const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => { const r = (Math.random() * 16) | 0; return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16); }));
export const baht = (satang: number) => (satang / 100).toFixed(2);
