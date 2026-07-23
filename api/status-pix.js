import { consultarPagamento, lerMetadata, normalizarStatus } from '../lib/mp.js';
import { tokenValido } from '../lib/seguranca.js';
import { montarAcessos } from '../lib/entrega.js';

/**
 * GET /api/status-pix?id=<payment_id>&token=<token>
 *
 * Resposta:
 *   { status: "pending" | "approved" | "rejected" | "cancelled" | "refunded",
 *     valor?: number,
 *     purchase_event_id?: string,
 *     acessos?: [{ nome, url }] }
 *
 * "acessos" so aparece quando status === "approved". Esta e a unica porta
 * de saida dos links de entrega no sistema inteiro.
 *
 * O token e um HMAC do payment_id, gerado no /api/criar-pix. Sem ele daria
 * pra varrer IDs sequenciais ate cair num pagamento aprovado de outra
 * pessoa e levar o acesso sem pagar.
 */
export default async function handler(req, res) {
  // Consulta de status nunca pode ser cacheada por CDN nem pelo navegador.
  res.setHeader('Cache-Control', 'no-store, max-age=0');

  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Metodo nao permitido' });
  }

  const id = String(req.query.id || '').trim();
  const token = String(req.query.token || '').trim();

  // Id de pagamento do MP e numerico. Recusar o resto corta varredura na entrada.
  if (!/^\d{1,20}$/.test(id)) {
    return res.status(400).json({ error: 'Pagamento invalido' });
  }

  try {
    if (!tokenValido(id, token)) {
      // Mesma mensagem do id invalido: nao entregamos pista de qual dos dois errou.
      return res.status(403).json({ error: 'Pagamento invalido' });
    }
  } catch (e) {
    console.error('[status-pix] CHECKOUT_SECRET ausente:', e.message);
    return res.status(500).json({ error: 'Servico indisponivel' });
  }

  let pagamento;
  try {
    pagamento = await consultarPagamento(id);
  } catch (e) {
    if (e.status === 404) {
      return res.status(404).json({ error: 'Pagamento nao encontrado' });
    }
    // Timeout ou instabilidade do MP: o checkout tenta de novo em 4s.
    console.error('[status-pix] falha ao consultar MP:', e.status, e.message, e.mp || '');
    return res.status(502).json({ error: 'Nao foi possivel verificar o pagamento agora' });
  }

  const status = normalizarStatus(pagamento);
  const meta = lerMetadata(pagamento);

  const resposta = { status };

  if (status === 'approved') {
    resposta.valor = Number(pagamento.transaction_amount) || undefined;
    // Mesmo event_id usado pelo webhook na CAPI, para a Meta nao contar
    // a venda duas vezes (navegador + servidor).
    if (meta.purchase_event_id) resposta.purchase_event_id = meta.purchase_event_id;

    resposta.acessos = montarAcessos(meta.bumps);

    if (resposta.acessos.length === 0) {
      // Pagou e nao ha link configurado. O checkout mostra o texto de
      // "confira seu e-mail", mas isso precisa gritar no log.
      console.error(`[status-pix] pagamento ${id} aprovado sem nenhum link de acesso configurado`);
    }
  }

  return res.status(200).json(resposta);
}
