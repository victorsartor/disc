/**
 * O anel que sustenta o audio isolado do Windows. Roda na thread de audio.
 *
 * POR QUE UM ARQUIVO, E NAO UMA STRING EM BLOB. Ja foi um Blob, e o Blob
 * quebrou em producao sem fazer barulho: a CSP do index.html traz
 * `script-src 'self'`, e uma blob: URL nao e 'self'. O Chromium recusava o
 * addModule, o isolamento caia no caminho de reserva - o loopback do sistema
 * INTEIRO - e quem assistia voltava a se ouvir. Em dev nada disso aparecia,
 * porque o harness de teste nao tinha index.html nem CSP.
 *
 * Como arquivo ele vira um asset com URL relativa, mesma origem do
 * documento, e passa no 'self' sem precisar afrouxar a CSP.
 */
class AnelDeAudio extends AudioWorkletProcessor {
  constructor(opcoes) {
    super();
    const canais = opcoes.processorOptions.canais;
    const quadros = opcoes.processorOptions.quadros;
    this.canais = canais;
    this.anel = new Float32Array(quadros * canais);
    this.tamanho = this.anel.length;
    this.escrita = 0;
    this.leitura = 0;
    this.disponivel = 0;
    this.port.onmessage = (e) => this.escrever(e.data);
  }

  escrever(bloco) {
    const n = bloco.length;
    // Sobra: o consumidor ficou pra tras (aba escondida, maquina travando).
    // Joga fora o mais VELHO em vez do mais novo - audio atrasado nao
    // interessa a ninguem, e assim a latencia nao cresce pra sempre.
    if (this.disponivel + n > this.tamanho) {
      const excesso = this.disponivel + n - this.tamanho;
      this.leitura = (this.leitura + excesso) % this.tamanho;
      this.disponivel -= excesso;
    }
    for (let i = 0; i < n; i++) {
      this.anel[this.escrita] = bloco[i];
      this.escrita = (this.escrita + 1) % this.tamanho;
    }
    this.disponivel += n;
  }

  process(_entradas, saidas) {
    const saida = saidas[0];
    const quadros = saida[0].length;
    const precisa = quadros * this.canais;

    if (this.disponivel < precisa) {
      // Falta: silencio. Melhor um vazio curto que um estouro de ritmo.
      for (let c = 0; c < saida.length; c++) saida[c].fill(0);
      return true;
    }

    for (let q = 0; q < quadros; q++) {
      for (let c = 0; c < this.canais; c++) {
        const amostra = this.anel[this.leitura];
        this.leitura = (this.leitura + 1) % this.tamanho;
        if (c < saida.length) saida[c][q] = amostra;
      }
    }
    this.disponivel -= precisa;
    return true;
  }
}
registerProcessor('anel-de-audio', AnelDeAudio);
