import crypto from 'node:crypto';
import { consultarPagamento, lerMetadata, normalizarStatus, assinaturaWebhookValida } from '../lib/mp.js';
import { enviarEvento } from '../lib/meta.js';

/**
 * POST /api/webhook-mp
 *
 * O Mercado Pago avisa aqui quando um pagamento muda de estado.
 * Este e o unico lugar do sistema autorizado a dizer "houve uma venda".
 *
 * Por que o Purchase sai daqui e nao do navegador:
 *
 *  - Chega mesmo se o cliente fechar a aba logo apos pagar.
 *  - Chega mesmo com bloqueador de anuncio ativo.
 *  - Nao pode ser forjado: sem a assinatura do MP, nada passa.
 *
 * O que este endpoint NAO tem: cookie, IP e user agent do cliente.
 * Ele le esses dados do metadata que o /api/criar-pix congelou la atras.
 */
export default async function handler(req, res) {
  // O MP reenvia enquanto nao receber 2xx. Erro nosso nao pode virar
  // tempestade de retentativa, entao respondemos 200 quase sempre e
  // registramos o problema no log.
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).end();
  }

  if (!assinaturaWebhookValida(req, crypto)) {
    // Aqui sim recusamos: nao veio do Mercado Pago.
    console.warn('[webhook] assinatura invalida — ignorado');
    return res.status(401).json({ error: 'assinatura invalida' });
  }

  const corpo = typeof req.body === 'object' && req.body ? req.body : {};
  const tipo = corpo.type || corpo.topic || '';
  const id = String(req.query?.['data.id'] || corpo?.data?.id || '');

  if (tipo !== 'payment' || !id) {
    return res.status(200).json({ ignorado: true });
  }

  let pagamento;
  try {
    // Nunca confiar no corpo da notificacao para saber o status.
    // A fonte da verdade e a consulta na API.
    pagamento = await consultarPagamento(id);
  } catch (e) {
    console.error('[webhook] falha ao consultar pagamento', id, e.message);
    // 500 de proposito: queremos que o MP tente de novo.
    return res.status(500).json({ error: 'consulta falhou' });
  }

  const status = normalizarStatus(pagamento);
  if (status !== 'approved') {
    return res.status(200).json({ status });
  }

  const meta = lerMetadata(pagamento);
  const m = pagamento.metadata || {};

  const resultado = await enviarEvento({
    eventName: 'Purchase',
    // Mesmo id que a tela do cliente usa. O MP manda varias notificacoes
    // para o mesmo pagamento; com event_id fixo, a Meta conta uma venda so.
    eventId: meta.purchase_event_id || `pur_${pagamento.external_reference || id}`,
    eventTime: pagamento.date_approved ? new Date(pagamento.date_approved).getTime() : Date.now(),
    sourceUrl: m.event_source_url || undefined,
    user: {
      email: m.email || pagamento.payer?.email || '',
      telefone: m.telefone || '',
      nome: m.nome || '',
      externalId: m.email || pagamento.payer?.email || '',
      // Estes quatro so existem porque foram salvos na criacao do PIX.
      fbp: m.fbp || '',
      fbc: m.fbc || '',
      ip: m.client_ip || '',
      ua: m.client_ua || '',
    },
    custom: {
      value: Number(pagamento.transaction_amount) || 0,
      currency: pagamento.currency_id || 'BRL',
      content_type: 'product',
      order_id: pagamento.external_reference || String(id),
    },
  });

  if (!resultado.ok) {
    console.error('[webhook] Purchase nao chegou na Meta:', id, resultado.motivo);
    // 500 faz o MP reenviar, e a nova tentativa reenvia o Purchase.
    // Como o event_id e o mesmo, a Meta deduplica e nao ha risco de
    // contar a venda duas vezes.
    return res.status(500).json({ error: 'capi falhou' });
  }

  return res.status(200).json({ ok: true });
}
