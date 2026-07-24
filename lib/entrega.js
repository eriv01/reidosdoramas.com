import { PRODUTO, BUMPS } from './precos.js';

/**
 * Onde ficam os links de entrega.
 *
 * Eles vem de variaveis de ambiente na Vercel, nao do codigo. Assim:
 *  - nao vazam no HTML nem no bundle;
 *  - nao ficam no historico do GitHub;
 *  - voce troca o link sem novo deploy.
 *
 * Configure na Vercel (Settings > Environment Variables):
 *   ACESSO_PRINCIPAL, ACESSO_BUMP1, ACESSO_BUMP2
 */
const MAPA = {
  principal: { nome: `ACESSAR ${PRODUTO.nome}`, env: 'ACESSO_PRINCIPAL' },
  bump1: { nome: `Acessar: ${BUMPS.bump1.nome}`, env: 'ACESSO_BUMP1' },
  bump2: { nome: `Acessar: ${BUMPS.bump2.nome}`, env: 'ACESSO_BUMP2' },
};

/**
 * Monta a lista de acessos de um pedido aprovado.
 * So chame isto depois de confirmar que o pagamento esta approved.
 *
 * @param {string[]} bumps ids dos bumps comprados
 * @returns {{nome:string, url:string}[]}
 */
export function montarAcessos(bumps = []) {
  const ids = ['principal', ...bumps.filter((id) => Object.hasOwn(MAPA, id))];
  const acessos = [];

  for (const id of ids) {
    const url = process.env[MAPA[id].env];
    if (!url) {
      // Cliente pagou e o link nao esta configurado. Isso e incidente,
      // nao detalhe: precisa aparecer no log da Vercel.
      console.error(`[entrega] variavel ${MAPA[id].env} vazia — cliente pagou e nao tem link`);
      continue;
    }
    acessos.push({ nome: MAPA[id].nome, url });
  }

  return acessos;
}
