/**
 * Cliente do Mercado Pago.
 * O access token NUNCA sai daqui. Ele so existe como variavel de
 * ambiente na Vercel e nunca e devolvido ao navegador.
 */

const BASE = 'https://api.mercadopago.com';

function token() {
  const t = process.env.MP_ACCESS_TOKEN;
  if (!t) throw new Error('MP_ACCESS_TOKEN nao configurado');
  return t;
}

/**
 * Chamada crua na API do MP, com timeout.
 * Sem timeout, uma lentidao do MP prende a funcao ate a Vercel matar
 * por tempo e o usuario fica olhando um botao girando.
 */
export async function mpFetch(caminho, opcoes = {}) {
  const { metodo = 'GET', corpo = null, idempotencia = null, ms = 8000 } = opcoes;

  const headers = {
    Authorization: `Bearer ${token()}`,
    Accept: 'application/json',
  };
  if (corpo) headers['Content-Type'] = 'application/json';
  if (idempotencia) headers['X-Idempotency-Key'] = idempotencia;

  let resposta;
  try {
    resposta = await fetch(`${BASE}${caminho}`, {
      method: metodo,
      headers,
      body: corpo ? JSON.stringify(corpo) : undefined,
      signal: AbortSignal.timeout(ms),
    });
  } catch (e) {
    const err = new Error(
      e.name === 'TimeoutError' ? 'Mercado Pago nao respondeu a tempo' : 'Falha de rede ao falar com o Mercado Pago'
    );
    err.status = 504;
    throw err;
  }

  const texto = await resposta.text();
  let dados = null;
  try {
    dados = texto ? JSON.parse(texto) : null;
  } catch {
    dados = null;
  }

  if (!resposta.ok) {
    const err = new Error(dados?.message || `Mercado Pago respondeu ${resposta.status}`);
    err.status = resposta.status;
    err.mp = dados; // guardado so pro log do servidor, nunca vai pro navegador
    throw err;
  }

  return dados;
}

/** Consulta um pagamento pelo id. */
export function consultarPagamento(id) {
  return mpFetch(`/v1/payments/${encodeURIComponent(id)}`);
}

/**
 * Cria um pagamento PIX.
 *
 * date_of_expiration vai com offset explicito (+00:00). O MP recusa o
 * formato com Z no fim, e esse e o erro 400 mais chato de diagnosticar
 * porque a mensagem que ele devolve nao aponta o campo.
 */
export function criarPagamentoPix({
  valor,
  descricao,
  pagador,
  metadata,
  referencia,
  notificationUrl,
  expiraMin = 30,
}) {
  const expiracao = new Date(Date.now() + expiraMin * 60_000)
    .toISOString()
    .replace('Z', '+00:00');

  const corpo = {
    transaction_amount: Number(valor.toFixed(2)),
    description: descricao,
    payment_method_id: 'pix',
    external_reference: referencia,
    date_of_expiration: expiracao,
    payer: {
      email: pagador.email,
      first_name: pagador.primeiroNome,
      last_name: pagador.sobrenome,
      identification: { type: 'CPF', number: pagador.cpf },
    },
    metadata,
  };
  if (notificationUrl) corpo.notification_url = notificationUrl;

  return mpFetch('/v1/payments', {
    metodo: 'POST',
    corpo,
    // Se a rede cair no meio e o navegador reenviar, o MP devolve o
    // mesmo pagamento em vez de cobrar duas vezes do cliente.
    idempotencia: referencia,
    ms: 12000,
  });
}

/**
 * Valida a assinatura do webhook.
 *
 * Sem isto, qualquer pessoa que descubra a URL manda um POST dizendo
 * "pagamento aprovado" e leva o produto sem pagar. E a checagem mais
 * importante do sistema inteiro.
 *
 * O MP monta a assinatura sobre:  id:<data.id>;request-id:<x-request-id>;ts:<ts>;
 */
export function assinaturaWebhookValida(req, cryptoMod) {
  const segredo = process.env.MP_WEBHOOK_SECRET;
  if (!segredo) {
    console.error('[mp] MP_WEBHOOK_SECRET ausente — webhook recusado');
    return false;
  }

  const assinatura = String(req.headers['x-signature'] || '');
  const requestId = String(req.headers['x-request-id'] || '');
  if (!assinatura) return false;

  let ts = '';
  let v1 = '';
  for (const parte of assinatura.split(',')) {
    const [chave, valor] = parte.split('=').map((s) => (s || '').trim());
    if (chave === 'ts') ts = valor;
    if (chave === 'v1') v1 = valor;
  }
  if (!ts || !v1) return false;

  // Recusa notificacao antiga: bloqueia reenvio de um POST capturado antes.
  const idadeMin = Math.abs(Date.now() - Number(ts)) / 60000;
  if (!Number.isFinite(idadeMin) || idadeMin > 15) {
    console.error('[mp] assinatura fora da janela de tempo:', idadeMin, 'min');
    return false;
  }

  const dataId = String(req.query?.['data.id'] || req.body?.data?.id || '').toLowerCase();
  if (!dataId) return false;

  const manifesto = `id:${dataId};request-id:${requestId};ts:${ts};`;
  const esperado = cryptoMod.createHmac('sha256', segredo).update(manifesto).digest('hex');

  const a = Buffer.from(esperado, 'utf8');
  const b = Buffer.from(v1, 'utf8');
  if (a.length !== b.length) return false;
  return cryptoMod.timingSafeEqual(a, b);
}

/**
 * O MP normaliza as chaves de metadata para snake_case minusculo e as
 * vezes devolve arrays como string. Esta funcao le os dois formatos.
 */
export function lerMetadata(pagamento) {
  const m = pagamento?.metadata || {};

  let bumps = m.bumps ?? [];
  if (typeof bumps === 'string') {
    bumps = bumps.split(',').map((s) => s.trim()).filter(Boolean);
  }
  if (!Array.isArray(bumps)) bumps = [];

  return {
    bumps,
    purchase_event_id: m.purchase_event_id || null,
    desconto: m.desconto === true || m.desconto === 'true',
  };
}

/**
 * Traduz o status do MP para o que o checkout entende.
 * refunded e charged_back NAO podem liberar acesso: o dinheiro voltou.
 */
export function normalizarStatus(pagamento) {
  const s = pagamento?.status;
  if (s === 'approved') return 'approved';
  if (s === 'rejected') return 'rejected';
  if (s === 'cancelled') return 'cancelled';
  if (s === 'refunded' || s === 'charged_back') return 'refunded';
  return 'pending'; // pending, in_process, authorized, in_mediation
}
