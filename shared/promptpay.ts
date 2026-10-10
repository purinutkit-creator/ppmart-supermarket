// Thai PromptPay QR (EMVCo merchant-presented) payload generator.

function tlv(id: string, value: string) {
  return id + value.length.toString().padStart(2, '0') + value;
}

export function crc16ccitt(data: string): string {
  let crc = 0xffff;
  for (let i = 0; i < data.length; i++) {
    crc ^= data.charCodeAt(i) << 8;
    for (let j = 0; j < 8; j++) crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
  }
  return crc.toString(16).toUpperCase().padStart(4, '0');
}

/**
 * @param target mobile number (0812345678), national/tax ID (13 digits) or e-wallet ID (15 digits)
 * @param amountSatang amount; when given, a one-time (dynamic) QR with embedded amount is produced
 */
export function promptPayPayload(target: string, amountSatang?: number): string {
  const id = target.replace(/[^0-9]/g, '');
  let acc: string;
  if (id.length >= 15) acc = tlv('03', id);
  else if (id.length >= 13) acc = tlv('02', id);
  else acc = tlv('01', ('0000000000000' + id.replace(/^0/, '66')).slice(-13));
  const merchant = tlv('29', tlv('00', 'A000000677010111') + acc);
  let payload =
    tlv('00', '01') +
    tlv('01', amountSatang ? '12' : '11') +
    merchant +
    tlv('58', 'TH') +
    tlv('53', '764') +
    (amountSatang ? tlv('54', (amountSatang / 100).toFixed(2)) : '');
  payload += '6304';
  return payload + crc16ccitt(payload);
}
