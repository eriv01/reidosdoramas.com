/**
 * CAMADA DE ATRIBUICAO
 *
 * Os identificadores que a Meta usa para ligar um evento a uma pessoa:
 *
 *   _fbc  -> veio do clique no anuncio (fbclid na URL). E o mais valioso.
 *   _fbp  -> identificador do navegador, primeira visita.
 *   ip    -> so existe em requisicao vinda do navegador.
 *   ua    -> idem.
 *
 * O problema que este arquivo resolve: normalmente quem cria _fbc e _fbp
 * e o fbevents.js da Meta. Se um bloqueador barrar esse script, os dois
 * cookies nunca existem e toda venda daquele usuario vira orfa — chega na
 * Meta sem vinculo com o anuncio que a gerou.
 *
 * Aqui o SERVIDOR cria os dois, como cookie de primeira parte, no seu
 * proprio dominio. Bloqueador nao tem como impedir.
 */

const NOVENTA_DIAS = 90 * 24 * 60 * 60;

function lerCookie(req, nome) {
  const bruto = req.headers.cookie || '';
  for (const parte of bruto.split(';')) {
    const [k, ...resto] = parte.trim().split('=');
    if (k === nome) return decodeURIComponent(resto.join('='));
  }
  return '';
}

/**
 * IP real do cliente. Na Vercel a requisicao passa por proxy, entao
 * req.socket traria o IP do proxy, nao o do usuario.
 */
export function ipCliente(req) {
  const encaminhado = req.headers['x-forwarded-for'] || '';
  const primeiro = String(encaminhado).split(',')[0].trim();
  return primeiro || req.headers['x-real-ip'] || '';
}

export function uaCliente(req) {
  return String(req.headers['user-agent'] || '').slice(0, 400);
}

/** Formato exigido pela Meta: fb.1.<timestamp>.<valor> */
function montar(valor) {
  return `fb.1.${Date.now()}.${valor}`;
}

function validoFb(v) {
  return typeof v === 'string' && /^fb\.1\.\d+\..+/.test(v);
}

/**
 * Resolve fbp e fbc para esta requisicao, criando o que faltar.
 *
 * Ordem de prioridade do fbc:
 *   1. fbclid presente agora na URL (clique fresco, sempre vence)
 *   2. cookie _fbc ja existente
 *   3. valor mandado pelo navegador
 *
 * @returns {{ fbp:string, fbc:string, novos:{fbp?:string, fbc?:string} }}
 */
export function resolverIds(req, corpo = {}) {
  const novos = {};

  let fbp = corpo.fbp || lerCookie(req, '_fbp');
  if (!validoFb(fbp)) {
    // 10 digitos aleatorios, mesmo formato que o fbevents.js usa
    fbp = montar(String(Math.floor(Math.random() * 9e9) + 1e9));
    novos.fbp = fbp;
  }

  let fbc = '';
  const fbclid = String(corpo.fbclid || '').trim();
  if (fbclid) {
    fbc = montar(fbclid.slice(0, 500));
    novos.fbc = fbc; // clique novo sobrescreve o cookie antigo
  } else {
    fbc = corpo.fbc || lerCookie(req, '_fbc');
    if (!validoFb(fbc)) fbc = '';
  }

  return { fbp, fbc, novos };
}

/**
 * Grava os cookies que acabaram de ser criados.
 * SameSite=Lax porque o usuario chega de um clique externo (Instagram,
 * Facebook) e com Strict o cookie nao seria enviado nessa primeira volta.
 * Sem HttpOnly de proposito: o fbevents.js precisa conseguir ler.
 */
export function gravarCookies(res, novos) {
  const cookies = Object.entries(novos).map(
    ([nome, valor]) =>
      `_${nome}=${encodeURIComponent(valor)}; Max-Age=${NOVENTA_DIAS}; Path=/; SameSite=Lax; Secure`
  );
  if (cookies.length) res.setHeader('Set-Cookie', cookies);
}

/**
 * Empacota a atribuicao para guardar no metadata do pagamento.
 * O webhook do Mercado Pago nao tem cookie, IP nem user agent do cliente —
 * ele so tem o que foi salvo aqui, no momento em que o navegador ainda
 * estava presente.
 */
export function empacotarParaMetadata({ fbp, fbc, ip, ua, url }) {
  return {
    fbp: (fbp || '').slice(0, 120),
    fbc: (fbc || '').slice(0, 300),
    client_ip: (ip || '').slice(0, 60),
    client_ua: (ua || '').slice(0, 300),
    event_source_url: (url || '').slice(0, 300),
  };
}
