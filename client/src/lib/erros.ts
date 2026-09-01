/**
 * Transforma a falha de uma chamada de API na frase que vai pra tela.
 *
 * Existe porque toda falha virava a mesma mensagem genérica, e a genérica
 * esconde justamente a única que a pessoa consegue resolver sozinha: o
 * servidor ainda estar na versão anterior à do app. Nesse estado tudo o mais
 * funciona e só a funcionalidade nova falha — o sintoma mais confuso
 * possível, e o estado normal por alguns minutos a cada atualização.
 *
 * O código vem no começo da mensagem porque propriedade de Error não
 * atravessa o IPC; ver o apiFetch em electron/main.ts.
 */
export function mensagemDeErro(err: unknown, padrao: string): string {
  const texto = err instanceof Error ? err.message : String(err);

  // Rota inexistente: o servidor é mais velho que este app.
  if (texto.includes('HTTP_404')) {
    return 'O servidor ainda está na versão anterior. Atualize ele e tente de novo.';
  }
  if (texto.includes('HTTP_403')) return 'Isso não é seu pra mexer.';
  if (texto.includes('HTTP_409')) return 'Apague a mensagem antes de tirá-la da conversa.';
  if (texto.includes('HTTP_410')) return 'Essa mensagem já foi apagada.';
  if (texto.includes('HTTP_429')) return 'Devagar aí — tenta de novo daqui a pouco.';
  if (texto.includes('HTTP_401') || texto.includes('sessao expirada')) {
    return 'Sua sessão expirou. Entre de novo.';
  }
  // 5xx e queda de rede não têm conselho útil: fica o texto de quem chamou,
  // que pelo menos diz O QUE não deu certo.
  return padrao;
}
