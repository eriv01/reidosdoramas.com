/**
 * FONTE DA VERDADE DOS PRECOS.
 * O navegador so EXIBE valores. Quem cobra e este arquivo.
 * Se alguem adulterar o front, o valor cobrado nao muda.
 */

export const PRODUTO = {
  nome: '1200 doramas',
  preco: 17.0,
};

/** Preco unitario do bump conforme a QUANTIDADE marcada. */
export const BUMP_BASE = 7.9;
export const BUMP_TIERS = [7.9, 6.9]; // 1 bump = 7,90 cada | 2 bumps = 6,90 cada

export const BUMPS = {
  bump1: { nome: '70 MIL HENTAIS E HQS +18' },
  bump2: { nome: '1200 REVISTAS +18 ANTIGAS' },
};

export const DESCONTO_PCT = 20; // cupom do modal de saida

/** Piso e teto de sanidade. Se o total sair daqui, e bug ou ataque. */
export const VALOR_MIN = 1.0;
export const VALOR_MAX = 500.0;

const round2 = (v) => Math.round(v * 100) / 100;

export function unitarioBump(qtd) {
  if (qtd <= 0) return BUMP_TIERS[0];
  return BUMP_TIERS[Math.min(qtd, BUMP_TIERS.length) - 1];
}

/**
 * Calcula o valor a cobrar.
 * @param {{ desconto?: boolean, bumps?: string[] }} entrada vinda do cliente
 * @returns {{ total:number, bumps:string[], desconto:boolean, descricao:string }}
 */
export function calcularTotal(entrada = {}) {
  // So aceita ids que existem. Qualquer coisa inventada e descartada.
  const bumps = Array.isArray(entrada.bumps)
    ? [...new Set(entrada.bumps)].filter((id) => Object.hasOwn(BUMPS, id))
    : [];

  const desconto = entrada.desconto === true;

  let base = PRODUTO.preco;
  if (desconto) base = base * (1 - DESCONTO_PCT / 100);

  const unit = unitarioBump(bumps.length);
  const total = round2(round2(base) + round2(unit * bumps.length));

  if (total < VALOR_MIN || total > VALOR_MAX) {
    throw new Error(`Valor calculado fora da faixa permitida: ${total}`);
  }

  const nomes = [PRODUTO.nome, ...bumps.map((id) => BUMPS[id].nome)];

  return {
    total,
    bumps,
    desconto,
    descricao: nomes.join(' + ').slice(0, 250),
  };
}
