import crypto from 'node:crypto';

const SEGREDO = process.env.CHECKOUT_SECRET || '';

/**
 * Token que amarra o navegador ao pagamento.
 * Sem ele, qualquer um chutaria IDs sequenciais no /api/status-pix
 * ate cair num pagamento aprovado alheio e levar os links de acesso.
 */
export function assinarToken(paymentId) {
  if (!SEGREDO) throw new Error('CHECKOUT_SECRET nao configurado');
  return crypto
    .createHmac('sha256', SEGREDO)
    .update(String(paymentId))
    .digest('hex')
    .slice(0, 32);
}

export function tokenValido(paymentId, token) {
  if (!token || typeof token !== 'string') return false;
  const esperado = assinarToken(paymentId);
  const a = Buffer.from(esperado, 'utf8');
  const b = Buffer.from(token, 'utf8');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b); // comparacao sem vazar tempo
}

/** Bloqueia chamadas feitas de fora do seu dominio. */
export function origemPermitida(req) {
  const permitidos = (process.env.SITE_URL || '')
    .split(',')
    .map((s) => s.trim().replace(/\/$/, ''))
    .filter(Boolean);

  if (permitidos.length === 0) return true; // sem SITE_URL definido, nao bloqueia

  const origem = req.headers.origin || req.headers.referer || '';
  if (!origem) return false;
  return permitidos.some((p) => origem.startsWith(p));
}

export function emailValido(v) {
  return typeof v === 'string' && /^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i.test(v.trim());
}

/** Valida CPF de verdade (digitos verificadores), nao so o tamanho. */
export function cpfValido(v) {
  const cpf = String(v || '').replace(/\D/g, '');
  if (cpf.length !== 11 || /^(\d)\1{10}$/.test(cpf)) return false;

  for (const [tamanho, posicao] of [[9, 10], [10, 11]]) {
    let soma = 0;
    for (let i = 0; i < tamanho; i++) soma += Number(cpf[i]) * (posicao - i);
    let dig = (soma * 10) % 11;
    if (dig === 10) dig = 0;
    if (dig !== Number(cpf[tamanho])) return false;
  }
  return true;
}

export function telefoneValido(v) {
  const d = String(v || '').replace(/\D/g, '');
  return d.length >= 10 && d.length <= 11;
}

/** Corta strings antes de mandar pra API externa. */
export function limpar(v, max = 120) {
  return String(v ?? '').trim().slice(0, max);
}
