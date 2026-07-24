import crypto from 'node:crypto';
import { criarPagamentoPix } from '../lib/mp.js';
import { calcularTotal } from '../lib/precos.js';
import { enviarEvento } from '../lib/meta.js';
import { resolverIds, gravarCookies, ipCliente, uaCliente, empacotarParaMetadata } from '../lib/atribuicao.js';
import { assinarToken, origemPermitida, emailValido, cpfValido, telefoneValido, limpar } from '../lib/seguranca.js';

/**
 * POST /api/criar-pix
 *
 * Recebe: { nome, email, cpf, celular, desconto, bumps, fbp, fbc, fbclid }
 * Devolve: { payment_id, token, qr_code, qr_code_base64, valor, expira_em }
 *
 * Duas responsabilidades que nao sao obvias pelo nome:
 *
 *  1. O VALOR e calculado aqui, do zero, a partir de lib/precos.js.
 *     O que o navegador manda sobre preco e ignorado — ele so escolhe
 *     QUAIS bumps quer, nunca quanto custam.
 *
 *  2. A ATRIBUICAO da Meta e congelada aqui dentro do metadata do
 *     pagamento. Este e o ultimo momento em que o navegador esta
 *     presente. Quando o webhook disparar o Purchase, o cliente ja
 *     terá ido embora e nao havera mais cookie, IP nem user agent.
 *     Sem este passo o Purchase sai sem vinculo com o anuncio.
 */
export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Metodo nao permitido' });
  }

  if (!origemPermitida(req)) {
    return res.status(403).json({ error: 'Origem nao permitida' });
  }

  const corpo = typeof req.body === 'object' && req.body ? req.body : {};

  const nome = limpar(corpo.nome, 120);
  const email = limpar(corpo.email, 160);
  const cpf = String(corpo.cpf || '').replace(/\D/g, '');
  const celular = String(corpo.celular || '').replace(/\D/g, '');

  if (nome.length < 3 || !nome.includes(' ')) {
    return res.status(400).json({ error: 'Informe nome e sobrenome' });
  }
  if (!emailValido(email)) {
    return res.status(400).json({ error: 'E-mail invalido' });
  }
  if (!cpfValido(cpf)) {
    return res.status(400).json({ error: 'CPF invalido' });
  }
  if (!telefoneValido(celular)) {
    return res.status(400).json({ error: 'WhatsApp invalido' });
  }

  let cobranca;
  try {
    cobranca = calcularTotal({ desconto: corpo.desconto, bumps: corpo.bumps });
  } catch (e) {
    console.error('[criar-pix] calculo de preco recusado:', e.message);
    return res.status(400).json({ error: 'Nao foi possivel calcular o total' });
  }

  const { fbp, fbc, novos } = resolverIds(req, corpo);
  gravarCookies(res, novos);

  const referencia = crypto.randomUUID();
  const purchaseEventId = `pur_${referencia}`;
  const apiEventId = `api_${referencia}`;

  const partes = nome.split(/\s+/);
  const site = (process.env.SITE_URL || '').split(',')[0].trim().replace(/\/$/, '');

  let pagamento;
  try {
    pagamento = await criarPagamentoPix({
      valor: cobranca.total,
      descricao: cobranca.descricao,
      referencia,
      notificationUrl: site ? `${site}/api/webhook-mp` : undefined,
      pagador: {
        email,
        primeiroNome: partes[0],
        sobrenome: partes.slice(1).join(' ') || partes[0],
        cpf,
      },
      metadata: {
        // Chaves em snake_case minusculo: o MP normaliza e devolveria
        // purchaseEventId como purchase_event_id de qualquer forma.
        bumps: cobranca.bumps.join(','),
        desconto: cobranca.desconto ? 'true' : 'false',
        purchase_event_id: purchaseEventId,
        nome,
        email,
        telefone: celular,
        ...empacotarParaMetadata({
          fbp,
          fbc,
          ip: ipCliente(req),
          ua: uaCliente(req),
          url: limpar(corpo.event_source_url, 300) || site,
        }),
      },
    });
  } catch (e) {
    console.error('[criar-pix] MP recusou:', e.status, e.message, JSON.stringify(e.mp || {}));
    return res.status(502).json({ error: 'Nao foi possivel gerar o PIX agora' });
  }

  const dados = pagamento?.point_of_interaction?.transaction_data;
  if (!dados?.qr_code) {
    console.error('[criar-pix] MP respondeu sem qr_code:', pagamento?.id, pagamento?.status);
    return res.status(502).json({ error: 'Nao foi possivel gerar o PIX agora' });
  }

  // Responde primeiro. O evento da Meta nao pode atrasar o QR na tela.
  res.status(200).json({
    payment_id: String(pagamento.id),
    token: assinarToken(pagamento.id),
    qr_code: dados.qr_code,
    qr_code_base64: dados.qr_code_base64 || null,
    valor: cobranca.total,
    expira_em: pagamento.date_of_expiration || null,
    event_id: apiEventId,
  });

  // AddPaymentInfo pelo servidor: chega mesmo com o fbq bloqueado.
  // O navegador dispara o mesmo apiEventId no pixel e a Meta deduplica.
  try {
    await enviarEvento({
      eventName: 'AddPaymentInfo',
      eventId: apiEventId,
      sourceUrl: limpar(corpo.event_source_url, 300) || site,
      user: {
        email,
        telefone: celular,
        nome,
        externalId: email,
        fbp,
        fbc,
        ip: ipCliente(req),
        ua: uaCliente(req),
      },
      custom: { value: cobranca.total, currency: 'BRL' },
    });
  } catch (e) {
    console.error('[criar-pix] AddPaymentInfo falhou:', e.message);
  }
}
