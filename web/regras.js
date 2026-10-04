// Regras automáticas do Altus, compartilhadas pelas telas.

const semAcento = (s) => String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toUpperCase().replace(/\s+/g, " ").trim();

// Veículo híbrido ou elétrico, pelo texto de marca/modelo/versão
const TERMOS_ELETRIFICADO = /(^|[^A-Z])(HYBRID|HIBRIDO|HEV|PHEV|MHEV|BEV|EV|ELETRICO|ELECTRIC|E-TECH|E-TRON|E-POWER|RECHARGE|EQA|EQB|EQC|EQE|EQS|PLUG-IN)([^A-Z]|$)/;
const MARCAS_ELETRIFICADAS = /^(BYD|TESLA|ZEEKR|NETA|JAC E|SERES)/;
const MODELOS_ELETRIFICADOS = /(^|[^A-Z])(DOLPHIN|SEAL|YUAN|SONG|TAN|HAN|KING|SHARK|LEAF|BOLT|IONIQ|ID\.?[34]|ID\.?BUZZ|EX30|EX40|C40|I3|IX|IX1|IX3|TAYCAN|ORA|HAVAL H6|TANK 300|E-JS1|E-JS4|E-208|E-2008|KWID E|SPARK EUV|EQUINOX EV|BLAZER EV|MUSTANG MACH|ARIATTO|AION|TIGGO 7 PRO HYBRID|TIGGO 8 PRO HYBRID)([^A-Z0-9]|$)/;
export function ehEletrificado(...textos) {
  const t = semAcento(textos.filter(Boolean).join(" "));
  if (!t) return false;
  return TERMOS_ELETRIFICADO.test(t) || MARCAS_ELETRIFICADAS.test(t) || MODELOS_ELETRIFICADOS.test(t);
}

// Peças soldadas da carroceria (não removíveis)
const SOLDADAS = /^(LATERAL|PARALAMA TRAS|COLUNA|CAIXA DE RODA|CAIXA DA SOLEIRA|SOLEIRA|LONGARINA|PAINEL TRAS|PAINEL DIANT|ASSOALHO|TETO|TRAVESSA|AVENTAL|TORRE|ALOJAMENTO|CHASSI|CAIXA DE AR|QUADRO DO PARABRISA|ESTRUTURA|FECHAMENTO DA LATERAL|LATERAL EXTERNA)/;
export const ehPecaSoldada = (peca) => SOLDADAS.test(semAcento(peca));

export const NOME_DESENERGIZACAO = "DESENERGIZAÇÃO DO SISTEMA DE ALTA TENSÃO";

// Inclui a desenergização quando há desamassado em peça soldada de híbrido/elétrico
export function aplicarDesenergizacao(itens, eletrificado, valor = 750) {
  const ja = itens.some((i) => semAcento(i.peca).startsWith("DESENERGIZ"));
  const precisa = eletrificado && itens.some((i) => i.decisao === "RECUPERAR" && ehPecaSoldada(i.peca));
  if (!precisa || ja) return false;
  itens.push({ peca: NOME_DESENERGIZACAO, lado: "", decisao: "SERVICO", pinta: false, hf: 0, hp: 0, hri: 0, hout: 0,
    valor: Number(valor) || 750, codigo: "", conf: 1,
    just: "Automático: veículo híbrido/elétrico com desamassado em peça soldada da carroceria." });
  return true;
}
