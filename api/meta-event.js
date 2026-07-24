import { enviarEvento } from '../lib/meta.js';
import { resolverIds, gravarCookies, ipCliente, uaCliente } from '../lib/atribuicao.js';
import { origemPermitida, limpar } from '../lib/seguranca.js';

/**
 * POST /api/meta-event
 *
 * Recebe eventos de funil do navegador (PageView, ViewContent,
 * InitiateCheckout) e repassa para a Conversions API.
 *
 * Por que passar pelo servidor em vez de deixar so o fbq resolver:
 *
 *  1. Bloqueadores derrubam connect.facebook.net. Quase nenhum derruba
 *     uma chamada do site para o proprio dominio dele.
 *  2. IP e user agent so existem numa requisicao vinda do navegador —
 *     e aqui e o unico lugar do sistema que tem os dois corretos.
 *  3. E aqui que _fbp e _fbc nascem quando o script da Meta foi barrado.
 *
 * Devolve os ids resolvidos para o navegador reaproveitar nos proximos
 * eventos, mantendo browser e servidor falando do mesmo usuario.
 */

const EVENTOS_ACEITOS = new Set([
  'PageView',
  'ViewContent',
  'InitiateCheckout',
  'AddPaymentInfo',
  'Lead',
]);

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

  const eventName = limpar(corpo.event_name, 40);
  // Purchase NAO entra por aqui. Ele so vale vindo do webhook, onde o
  // Mercado Pago ja confirmou o dinheiro. Aceitar Purchase do navegador
  // seria deixar qualquer um inflar conversao com um curl.
  if (!EVENTOS_ACEITOS.has(eventName)) {
    return res.status(400).json({ error: 'Evento nao suportado' });
  }

  const { fbp, fbc, novos } = resolverIds(req, corpo);
  gravarCookies(res, novos);

  // Responde antes de esperar a Meta: o navegador nao precisa aguardar,
  // e travar a interface por causa de rastreamento e inaceitavel.
  res.status(200).json({ ok: true, fbp, fbc });

  try {
    await enviarEvento({
      eventName,
      eventId: limpar(corpo.event_id, 80) || undefined,
      sourceUrl: limpar(corpo.event_source_url, 300),
      user: {
        email: limpar(corpo.user?.email, 160),
        telefone: limpar(corpo.user?.phone, 30),
        nome: limpar(corpo.user?.nome, 120),
        externalId: limpar(corpo.user?.email, 160),
        fbp,
        fbc,
        ip: ipCliente(req),
        ua: uaCliente(req),
      },
      custom: typeof corpo.custom_data === 'object' && corpo.custom_data ? corpo.custom_data : {},
    });
  } catch (e) {
    console.error('[meta-event] falha ao repassar', eventName, e.message);
  }
}
