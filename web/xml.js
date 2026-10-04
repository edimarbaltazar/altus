// Importação de orçamentos de seguradora (XML).
// Formato suportado: Porto Seguro (sistema SOMA, <orcamentoVistoria>).

const num = (v) => { const n = parseFloat(String(v ?? "").replace(",", ".")); return Number.isFinite(n) ? n : 0; };
const r1 = (v) => Math.round(v * 10) / 10;
const filho = (el, nome) => (el ? [...el.children].find((c) => c.localName === nome) || null : null);
const filhos = (el, nome) => (el ? [...el.children].filter((c) => c.localName === nome) : []);
function txt(el, caminho) {
  let e = el;
  for (const p of caminho.split(".")) { e = filho(e, p); if (!e) return ""; }
  return (e.textContent || "").trim();
}

// "EMBLEMA EMBLEMA (EMBLEMA FLEX TAMPA TR" -> "EMBLEMA FLEX TAMPA TR"; "LENTE LENTE LANTERNA LD P.CHOQUE)" -> "LENTE LANTERNA DIR P.CHOQUE"
export function limparNome(s) {
  let n = String(s || "").toUpperCase().trim();
  if (n.includes("(")) n = n.slice(n.lastIndexOf("(") + 1);
  n = n.replace(/[()]/g, " ").replace(/\s+/g, " ").trim();
  const t = n.split(" ");
  const out = t.filter((w, i) => i === 0 || w !== t[i - 1]);
  return out.join(" ").replace(/(^| )LE( |$)/g, "$1ESQ$2").replace(/(^| )LD( |$)/g, "$1DIR$2").trim();
}
const ladoDe = (n) => (/(^| )(ESQ|LE)( |$)/.test(n) ? "ESQ" : /(^| )(DIR|LD)( |$)/.test(n) ? "DIR" : "");

const DECISAO = { T: "TROCAR", R: "RECUPERAR", M: "REMOVER_INSTALAR", P: "SO_PINTAR" };
const USO = { F: "funilaria", A: "acabamento", T: "tapeçaria", E: "elétrica", M: "mecânica" };

export function lerXmlOrcamento(texto) {
  const doc = new DOMParser().parseFromString(texto, "application/xml");
  if (doc.getElementsByTagName("parsererror").length) throw new Error("O arquivo não é um XML válido.");
  const raiz = doc.documentElement;
  if (raiz.localName !== "orcamentoVistoria") {
    throw new Error("Este formato de XML ainda não é reconhecido pelo Altus. Envie o arquivo para o suporte que nós incluímos.");
  }
  const versoes = filhos(raiz, "orcamentosVersoes");
  if (!versoes.length) throw new Error("O XML não tem itens de orçamento.");
  const v = versoes[versoes.length - 1];

  // totais e valor da hora usados pela seguradora
  const totais = {};
  for (const t of filhos(v, "orcamentoVersaoValoresTotais")) totais[txt(t, "tipoValorTotal.descricaoTipoValorTotal")] = num(txt(t, "valorTotal"));
  const taxa = (valor, horas, padrao) => (totais[horas] > 0 ? r1(totais[valor] / totais[horas]) : padrao);
  const fun = taxa("Valor Total Mão de Obra Peças Funilaria", "Horas Total Mão de Obra Peças Funilaria", 0);
  const pin = taxa("Valor Total Pintura Peças Funilaria", "Horas Total Pintura Peças Funilaria", fun);
  const tap = taxa("Valor Total Mão de Obra Peças Tapeçaria", "Horas Total Mão de Obra Peças Tapeçaria", fun);
  const taxas = fun ? { fun, pin: pin || fun, ri: fun, out: tap || fun } : null;

  const itens = [];
  for (const p of filhos(v, "pecasItemOrcamento")) {
    const nome = limparNome(txt(p, "descricaoPeca"));
    const cod = txt(p, "tipoServicoItemOrcamento.codigoTipoServico");
    const decisao = DECISAO[cod] || "RECUPERAR";
    const uso = txt(p, "tipoUsoPeca.codigoTipoUsoPeca");
    const tMO = num(txt(p, "valorTempoMaoObra")), tPin = num(txt(p, "valorTempoPintura")), vRec = num(txt(p, "valorRecuperacao"));
    const qtd = num(txt(p, "quantidadeItemPeca")) || 1;
    const fornecida = txt(p, "flagPecaFornecimento") === "S";
    const it = { peca: nome, lado: ladoDe(nome), decisao, pinta: tPin > 0, hf: 0, hp: tPin, hri: 0, hout: 0, valor: 0,
      codigo: txt(p, "pecaItemOrcamentoPK.codigoPeca"), conf: 1, just: `XML: ${txt(p, "tipoServicoItemOrcamento.descricaoTipoServico") || decisao} · ${USO[uso] || "peça"}` };
    if (decisao === "RECUPERAR") {
      it.hf = tMO;
      if (vRec > 0) { it.vrec = vRec; it.just += ` · recuperação negociada R$ ${vRec.toFixed(2).replace(".", ",")}`; }
    } else if (uso === "F" || uso === "A") it.hri = tMO;
    else it.hout = tMO;
    if (decisao === "TROCAR") {
      it.valor = fornecida ? 0 : Math.round(num(txt(p, "valorLiquidoPecaItem")) * qtd * 100) / 100;
      if (fornecida) it.just += " · peça fornecida pela seguradora";
    }
    itens.push(it);
  }
  for (const p of filhos(v, "pecasManuaisItemOrcamento")) {
    const nome = limparNome(txt(p, "descricaoPecaManual"));
    if (!nome) continue;
    const qtd = num(txt(p, "quantidadeItemPeca")) || 1;
    itens.push({ peca: nome, lado: ladoDe(nome), decisao: "TROCAR", pinta: false, hf: 0, hp: num(txt(p, "valorTempoPintura")),
      hri: num(txt(p, "valorTempoMaoObra")), hout: 0, valor: Math.round(num(txt(p, "valorLiquidoPecaItem")) * qtd * 100) / 100,
      codigo: "", conf: 1, just: "XML: peça incluída manualmente pela seguradora" });
  }
  let terceiros = 0; const codTerceiros = [];
  for (const s of filhos(v, "servicosTerceiroItemOrcamento")) {
    terceiros += num(txt(s, "valorLiquidoServicoTerceiro")) * (num(txt(s, "quantidadeItemServico")) || 1);
    codTerceiros.push(txt(s, "servicoTerceiroItemOrcamentoPK.codigoServicoTerceiroEmpresa"));
  }

  const veic = filho(raiz, "veiculoVistoria");
  const sin = filhos(raiz, "sinistroVistorias")[0];
  const observacoes = [];
  const ocorr = txt(sin, "descricaoOcorrencia");
  if (ocorr) observacoes.push("Ocorrência: " + ocorr);
  for (const n of filhos(raiz, "notasVistoria")) { const d = txt(n, "descricaoNota"); if (d) observacoes.push("Nota da vistoria: " + d); }
  if (terceiros) observacoes.push(`Serviços de terceiros no XML: R$ ${terceiros.toFixed(2).replace(".", ",")} (códigos ${codTerceiros.join(", ")}).`);
  const franquia = totais["Valor Franquia a receber"];
  if (franquia) observacoes.push(`Franquia a receber: R$ ${franquia.toFixed(2).replace(".", ",")}.`);

  return {
    veiculo: {
      placa: txt(veic, "codigoLicencaVeiculo") || null,
      marca: txt(veic, "descricaoMarcaVeiculo").toUpperCase() || null,
      modelo: (txt(veic, "descricaoTipoVeiculo") || txt(veic, "tipoCodigoModeloVeiculo")).toUpperCase() || null,
      versao: txt(veic, "descricaoModeloVeiculo") || null,
      ano: txt(veic, "anoModelo") || txt(veic, "anoFabricacao") || null,
      cor: txt(veic, "descricaoCorVeiculo") || null,
      chassi: txt(veic, "codigoChassiVeiculo") || null,
    },
    cliente_nome: txt(sin, "nomeCondutor") || null,
    seguradora: txt(raiz, "empresaSeguradora.nomeFantasia") || null,
    sinistro: txt(sin, "numeroSinistro") || null,
    itens,
    totais: { taxas, terceiros, xml_total: totais["Valor Total do Orçamento"] || null, xml_franquia: franquia || null, xml_liberado: totais["Valor Total Liberado"] || null },
    observacoes,
  };
}
