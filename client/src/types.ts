export interface Channel {
  id: string;
  name: string;
}

export interface Me {
  id: string;
  name: string;
  email: string;
  avatarUrl: string | null;
  channels: Channel[];
  livekitUrl: string;
  /**
   * Pode apagar mensagem dos outros. Vem do ADMIN_EMAILS do servidor.
   *
   * Serve pra tela decidir se DESENHA o botão. Quem decide se a mensagem some
   * é a rota, que confere de novo — esconder botão nunca foi controle de
   * acesso.
   */
  isAdmin: boolean;
  /** A tirinha de reações. Vem do servidor pra não haver duas listas. */
  reactionEmojis: string[];
  /**
   * Até onde você já leu o chat, na hora em que o app abriu.
   *
   * Vem do servidor pra valer nas DUAS máquinas. É lido uma vez só, no
   * carregamento — é o que ancora a linha de "novas mensagens" num ponto
   * fixo em vez dela andar sozinha conforme o ponteiro avança.
   */
  lastReadMessageId: number;
}

/**
 * O perfil de alguém, visto por qualquer pessoa do servidor.
 *
 * É o que abre ao clicar num nome — inclusive no seu. Vem do servidor a
 * cada abertura, então uma foto trocada pelo outro lado aparece aqui sem
 * precisar reiniciar o app.
 */
export interface UserProfile {
  id: string;
  name: string;
  avatarUrl: string | null;
  bannerUrl: string | null;
  bio: string;
  statusText: string;
  /**
   * Tempo acumulado em sala de voz, em ms.
   *
   * Vem bruto de propósito: quem decide se isso vira "40 min" ou "67h" é a
   * tela. Quem SOMA é o servidor, de 30 em 30 segundos, a partir do que o
   * LiveKit responde — o cliente nunca reporta o próprio tempo.
   */
  voiceMs: number;
  /** Um dos ids de lib/efeitos.ts. Ao contrário do tema, os outros veem. */
  profileEffect: string;
}

/**
 * Como o chat desenha o anexo. Vem decidido do servidor, não do mime.
 *
 * 'image' aparece na conversa e amplia no clique, 'audio' e 'video' ganham
 * player, 'file' vira cartão pra baixar. O servidor só marca os três
 * primeiros pra formato que ele mesmo se dispõe a servir com o
 * content-type de verdade — o resto cai em 'file' e desce como
 * octet-stream.
 *
 * O kind é gravado no upload, então vídeo mandado antes desta versão
 * continua sendo cartão de download. É o comportamento certo: o que já foi
 * mandado aparece como aparecia quando foi mandado.
 */
export type AttachmentKind = 'image' | 'audio' | 'video' | 'file';

export interface Attachment {
  id: string;
  name: string;
  mime: string;
  /** Bytes. É o que o cartão mostra como "2,4 MB". */
  size: number;
  kind: AttachmentKind;
  /**
   * Endereço pronto pra <img> e <audio>, montado pelo servidor — mesma
   * escolha da foto de perfil. Sem sessão: tag não manda header de
   * autorização, e quem protege é o id aleatório mais a tailnet.
   */
  url: string;
}

/**
 * Uma opção da enquete, já apurada pelo servidor.
 *
 * `voters` traz os ids, não só a contagem: quem votou aparece. São seis
 * pessoas — esconder isso seria atrito, não privacidade.
 */
export interface PollOption {
  text: string;
  voters: string[];
}

export interface Poll {
  id: number;
  question: string;
  /** Verdadeiro quando dá pra marcar mais de uma opção. */
  multi: boolean;
  options: PollOption[];
}

/** A enquete como sai do formulário, antes de existir no servidor. */
export interface NovaEnquete {
  question: string;
  options: string[];
  multi: boolean;
}

/**
 * Uma reação, já agrupada por emoji pelo servidor.
 *
 * `users` traz os ids em vez de só a contagem — mesma escolha do PollOption.
 * É o que deixa o tooltip dizer quem reagiu e o chip saber se VOCÊ está
 * dentro, sem uma segunda consulta.
 */
export interface Reaction {
  emoji: string;
  users: string[];
}

/**
 * O pedacinho da mensagem que está sendo respondida.
 *
 * O `snippet` chega pronto do servidor e é recalculado a cada leitura: se a
 * original for editada ou apagada, o card muda junto. Nunca é o texto
 * congelado no momento em que a resposta foi escrita.
 */
export interface ReplyPreview {
  id: number;
  author_name: string;
  snippet: string;
}

export interface Message {
  id: number;
  body: string;
  created_at: number;
  user_id: string;
  author_name: string;
  author_avatar: string | null;
  /**
   * Vazio na esmagadora maioria das mensagens. Pode faltar por completo
   * numa mensagem que chegou pelo data channel de um app antigo, daí o
   * opcional — quem lê precisa tratar undefined.
   */
  attachments?: Attachment[];
  /**
   * A enquete desta mensagem, com a apuração de quando a mensagem chegou.
   *
   * A apuração envelhece: quem vota depois muda o número, e o que
   * reconcilia é o servidor (ver o refresh de enquete no App). Nunca somar
   * voto no cliente a partir do que chegou pelo data channel.
   */
  poll?: Poll | null;
  /** Vazio na maioria. Opcional pelo mesmo motivo dos anexos: app antigo. */
  reactions?: Reaction[];
  /**
   * Ids de quem foi mencionado, resolvidos pelo SERVIDOR na gravação.
   *
   * É esta lista que decide o som e a notificação — nunca uma releitura do
   * texto aqui. O autor nunca está nela: mencionar a si mesmo não avisa
   * ninguém.
   */
  mentions?: string[];
  /** Quando foi editada. null/ausente = nunca foi. */
  edited_at?: number | null;
  /**
   * Lápide. O servidor já mandou tudo vazio — texto, anexo, enquete e
   * reações — e a tela desenha "mensagem removida" no lugar.
   */
  deleted?: boolean;
  /** A mensagem que esta responde, ou null. */
  reply_to?: ReplyPreview | null;
}

/**
 * Quem está num canal, visto de fora dele.
 *
 * Vem do servidor (que pergunta ao LiveKit), não da sala — por isso tem
 * menos informação que um Peer: sem "falando agora", sem volume. Essas
 * duas só existem para o canal em que você está.
 */
export interface PresenceMember {
  identity: string;
  name: string;
  avatarUrl: string | null;
  isMuted: boolean;
  isSharing: boolean;
}

/** canalId -> quem está lá dentro */
export type Presence = Record<string, PresenceMember[]>;

/** O que a pessoa escolhe no seletor da sidebar. */
export type StatusEscolhido = 'disponivel' | 'ausente' | 'invisivel';

/** O que se vê dos outros. 'invisivel' nunca chega aqui: vira 'offline'. */
export type StatusEfetivo = 'disponivel' | 'ausente' | 'offline';

/** Todo mundo do servidor, esteja em call ou não. */
export interface UserPresence {
  identity: string;
  name: string;
  avatarUrl: string | null;
  status: StatusEfetivo;
}

export interface ScreenSource {
  id: string;
  name: string;
  /** null quando o sistema nao entrega miniatura — o caso do Wayland. */
  thumbnail: string | null;
  isScreen: boolean;
}

export interface RoomTokenResponse {
  token: string;
  url: string;
  channelId: string;
}

export type VoiceMode = 'vad' | 'ptt';

/** Tecla vinculada: keycode do uiohook + como mostrar na tela. */
export interface KeyBinding {
  keycode: number;
  label: string;
}

/**
 * As ações que aceitam atalho global.
 *
 * Espelha ACOES_DE_ATALHO em electron/settings.ts, que é quem manda — o
 * `satisfies` logo abaixo é o que impede as duas listas de divergirem em
 * silêncio: acrescentar uma ação lá sem descrever aqui não compila.
 */
export type AcaoDeAtalho = 'mudo' | 'surdo';

/** Como cada ação se chama na tela das configurações. */
export const ROTULO_DA_ACAO = {
  mudo: 'Mudo do microfone',
  surdo: 'Surdo',
} satisfies Record<AcaoDeAtalho, string>;

/**
 * Os cantos em que a pilha de transmissões pode ancorar.
 *
 * Espelha TELA_CANTOS em electron/settings.ts, que é quem manda — o
 * `satisfies` do CANTOS logo abaixo impede as duas listas de divergirem em
 * silêncio.
 */
export type TelaCanto = 'cima-esq' | 'cima-dir' | 'baixo-esq' | 'baixo-dir';

/**
 * Onde cada canto fica, em fração da área: 0 é o começo do eixo, 1 é o fim.
 *
 * É desta tabela que sai o "gruda no mais perto" — com ela a conta é a
 * distância do centro da pilha até cada um dos quatro pontos, e não uma
 * escada de if comparando metades de largura e de altura.
 */
export const CANTOS = {
  'cima-esq': { x: 0, y: 0 },
  'cima-dir': { x: 1, y: 0 },
  'baixo-esq': { x: 0, y: 1 },
  'baixo-dir': { x: 1, y: 1 },
} satisfies Record<TelaCanto, { x: number; y: number }>;

export interface Settings {
  voiceMode: VoiceMode;
  pttKeycode: number | null;
  pttKeyLabel: string;
  micDeviceId: string | null;
  speakerDeviceId: string | null;
  /** Corte do portão de ruído, 0 a 100. 0 desliga o portão. */
  micSensitivity: number;
  noiseSuppression: boolean;
  echoCancellation: boolean;
  autoGainControl: boolean;
  /**
   * Supressão de ruído por RNNoise, além da do Chromium.
   *
   * A do Chromium (`noiseSuppression`) e o portão (`micSensitivity`) só
   * agem no silêncio entre as frases. Esta age DENTRO da fala: teclado e
   * ventilador somem enquanto você fala. Ver lib/rnnoise.ts.
   */
  rnnoise: boolean;
  volumes: Record<string, number>;
  /** identity -> volume do som da tela daquela pessoa (0 a 2). */
  screenVolumes: Record<string, number>;
  /**
   * Volume geral da voz, 0 a 100. Multiplica o slider de cada pessoa — não
   * substitui, então quem já tinha alguém baixado mantém a proporção.
   */
  voiceVolume: number;
  /** Volume dos sons de evento (entrar, sair, tela, notificação), 0 a 100. */
  effectsVolume: number;
  /** Volume dos áudios que as pessoas mandam no chat, 0 a 100. */
  chatVolume: number;
  /**
   * Dispositivo de onde tirar o som ao compartilhar tela no Linux.
   *
   * Existe porque o Chromium nao captura som de sistema no Linux: la o jeito
   * e gravar de um "monitor" do PipeWire, que aparece como se fosse
   * microfone. null = compartilhar so o video.
   */
  screenAudioDeviceId: string | null;
  /**
   * Tirar a Disneia do som transmitido, no Linux.
   *
   * Ligado, o app monta um desvio no servidor de som na hora de
   * compartilhar: tudo passa a tocar num destino virtual — menos a
   * Disneia — e é o monitor DESSE destino que vai pra transmissão. Quem
   * assiste para de se ouvir de volta.
   */
  isolarAudioNaTela: boolean;
  /** Um dos ids de lib/themes.ts. Vale pra maquina, nao pra conta. */
  theme: string;
  /**
   * As cores já resolvidas do tema em vigor, gravadas a cada troca.
   *
   * O renderer não lê isto — quem lê é o processo main, ao criar a janela.
   * Existem porque a janela nasce antes do CSS e precisa de uma cor de fundo
   * no construtor. Ver o comentário em electron/settings.ts.
   */
  themeBg: string;
  themeBar: string;
  themeSymbol: string;
  /**
   * Largura da barra lateral, em pixels. Preferência da máquina.
   *
   * Fica no settings.json (userData) e não no localStorage porque o userData
   * sobrevive à atualização do app. Os limites estão em electron/settings.ts
   * e são reaplicados lá: o que sai daqui é pedido, não verdade.
   */
  sidebarWidth: number;
  /**
   * Em que canto do chat a pilha de transmissões fica ancorada.
   *
   * Uma escolha só, e não uma por transmissão: as janelinhas se empilham a
   * partir do canto, e o arrasto move a pilha inteira. A lista fechada de
   * cantos vive em electron/settings.ts e é reaplicada lá.
   */
  telaCanto: TelaCanto;
  /**
   * Largura das janelinhas de transmissão, em px. A altura sai do vídeo.
   *
   * Mesma história do sidebarWidth: mora no settings.json porque o userData
   * sobrevive à atualização, e os limites de verdade estão no main.
   */
  telaLargura: number;
  /**
   * Atalhos globais por ação. Ação ausente = sem tecla vinculada.
   *
   * A lista fechada de ações vive em electron/settings.ts; o que não estiver
   * nela é descartado no patch. Patch aqui é SUBSTITUIÇÃO do mapa inteiro,
   * não merge — é assim que dá pra dizer "tira a tecla desta ação".
   */
  atalhos: Partial<Record<AcaoDeAtalho, KeyBinding>>;
  /** Falso em Wayland e onde o hook global de teclado nao sobe. */
  pttAvailable: boolean;
}

/** Espelha o UpdateState do processo main (electron/updater.ts). */
export type UpdateState =
  | { status: 'idle' }
  | { status: 'checking' }
  | { status: 'available'; version: string }
  | {
      status: 'downloading';
      version: string;
      percent: number;
      transferred: number;
      total: number;
      bytesPerSecond: number;
    }
  | { status: 'ready'; version: string }
  | { status: 'error'; message: string };

export interface DiscApi {
  auth: {
    status(): Promise<boolean>;
    login(): Promise<void>;
    logout(): Promise<void>;
    onChanged(cb: (loggedIn: boolean) => void): () => void;
  };
  update: {
    state(): Promise<UpdateState>;
    skip(): Promise<void>;
    version(): Promise<string>;
    onState(cb: (state: UpdateState) => void): () => void;
  };
  me(): Promise<Me>;
  messages(): Promise<{ messages: Message[] }>;
  presence(): Promise<{ channels: Presence; users: UserPresence[]; canais: Channel[] }>;
  /** Batimento do app aberto. `ativo` renova o relógio dos 10 minutos. */
  heartbeat(ativo: boolean): Promise<{ status: StatusEfetivo }>;
  setStatus(status: StatusEscolhido): Promise<{ status: StatusEscolhido }>;
  sendMessage(
    body: string,
    attachmentId?: string,
    poll?: NovaEnquete,
    replyToId?: number,
  ): Promise<{ message: Message }>;
  /**
   * Editar, apagar e reagir devolvem a MENSAGEM INTEIRA já remontada, não um
   * "ok". É o que permite aplicar o resultado sem adivinhar como ficou — e o
   * que faz o caminho rápido (data channel) e o polling de 3s concordarem,
   * já que os dois carregam exatamente o mesmo objeto.
   */
  editMessage(id: number, body: string): Promise<{ message: Message }>;
  /** Vira lápide. Autor sempre; mensagem dos outros só com isAdmin. */
  deleteMessage(id: number): Promise<{ message: Message }>;
  /**
   * Segundo estágio: tira a lápide da conversa de vez.
   *
   * Não devolve mensagem porque não há mais mensagem — devolve o id, que é
   * o que basta pra tirar da lista. Só aceita mensagem que JÁ é lápide: é
   * o que obriga a passar antes pelo deleteMessage, que é quem apaga os
   * bytes do anexo.
   */
  purgeMessage(id: number): Promise<{ removed: boolean; id: number }>;
  /** Liga/desliga a SUA reação. Mandar duas vezes volta ao estado inicial. */
  reactMessage(id: number, emoji: string): Promise<{ message: Message }>;
  /**
   * Avança seu ponteiro de leitura até esta mensagem. Idempotente e sem
   * risco de andar pra trás — ver o comentário do setLastRead no servidor.
   */
  markRead(messageId: number): Promise<{ lastReadMessageId: number }>;
  polls: {
    /**
     * A apuração de agora. Serve o aviso de voto do data channel: quem
     * recebe PERGUNTA quanto ficou em vez de somar um no que já tinha.
     */
    of(id: number): Promise<{ poll: Poll }>;
    /**
     * Manda o conjunto INTEIRO de opções marcadas, não um voto avulso.
     * Lista vazia desmarca. A resposta já vem com a apuração nova.
     */
    vote(id: number, options: number[]): Promise<{ poll: Poll }>;
  };
  /**
   * Isolamento do som da Disneia na transmissão. Só Linux.
   *
   * Sem isso, o monitor que o app grava pega TUDO que sai pela caixa — a
   * voz das pessoas junto — e quem assiste se ouve de volta.
   */
  audio: {
    /**
     * Monta o desvio e devolve a DESCRIÇÃO do dispositivo a capturar, ou
     * null quando não deu. Null não é erro: é o caminho de antes, com eco.
     */
    isolar(): Promise<string | null>;
    liberar(): Promise<void>;
    /**
     * Dá pra isolar nesta máquina?
     *
     * As duas metades respondem por caminhos diferentes: no Linux, se o
     * `pactl` responde; no Windows, se o componente nativo foi empacotado.
     */
    disponivel(): Promise<boolean>;
    /**
     * Windows: começa a captura isolada. Devolve a mensagem de erro, ou
     * undefined quando começou. A taxa é a do AudioContext de quem chama.
     */
    iniciar(taxa: number, canais: number): Promise<string | undefined>;
    parar(): Promise<void>;
    /** Windows: os quadros PCM chegando. Devolve como desinscrever. */
    onQuadros(cb: (amostras: Float32Array) => void): () => void;
  };
  arquivos: {
    /**
     * Sobe um arquivo do disco pelo CAMINHO, não pelos bytes.
     *
     * O processo main lê do disco e faz stream direto pro servidor: 200 MB
     * atravessando o IPC seriam copiados na memória dos dois lados. O
     * caminho sai do webUtils.getPathForFile — `File.path` foi removido no
     * Electron 32.
     */
    enviar(caminho: string): Promise<{ attachment: Attachment }>;
    /** Imagem já reduzida no renderer: pequena, então os bytes podem vir. */
    enviarImagem(bytes: Uint8Array, nome: string, mime: string): Promise<{ attachment: Attachment }>;
    /** Abre a janela de salvar e baixa. `false` = a pessoa cancelou. */
    baixar(id: string, nome: string): Promise<{ salvo: boolean }>;
    /** Caminho no disco de um File escolhido no seletor. */
    caminhoDe(file: File): string;
    /**
     * Progresso do upload em andamento, 0 a 100.
     *
     * Só sai pro caminho de ARQUIVO (`enviar`), que é o que faz stream do
     * disco e pode demorar de verdade — a imagem de `enviarImagem` já
     * chega reduzida e o upload dela é rápido demais pra valer uma barra.
     */
    onProgress(cb: (percent: number) => void): () => void;
  };
  roomToken(channelId: string): Promise<RoomTokenResponse>;
  /**
   * Criar, renomear e apagar canal de voz. Só quem é `me.isAdmin` — o
   * servidor confere de novo (403 pra quem não é), esconder o botão nunca
   * foi controle de acesso.
   *
   * Nenhuma delas mexe na lista local: a coluna se atualiza sozinha no
   * próximo ciclo da presença (até 3s), que agora também traz os canais.
   */
  canais: {
    criar(nome: string): Promise<{ channel: Channel }>;
    renomear(id: string, nome: string): Promise<{ channel: Channel }>;
    /** Idempotente: apagar um id que já sumiu responde sucesso. */
    remover(id: string): Promise<{ removed: boolean; id: string }>;
  };
  profile: {
    /** Perfil de qualquer um, pela identity do LiveKit ou pelo id. */
    of(identity: string): Promise<{ user: UserProfile }>;
    patch(patch: {
      name?: string;
      bio?: string;
      statusText?: string;
      profileEffect?: string;
    }): Promise<{ user: UserProfile }>;
    /** dataUrl null remove: a capa some, a foto volta pra do Google. */
    image(kind: 'avatar' | 'banner', dataUrl: string | null): Promise<{ user: UserProfile }>;
  };
  /**
   * Cores dos botões de janela: a barra é do SO e não lê o CSS do tema.
   * `bg` (o --level-1) não muda nada agora — fica guardado pra próxima
   * abertura, que é quando a cor errada apareceria como flash.
   */
  titlebar(color: string, symbolColor: string, bg?: string): Promise<void>;
  screenSources(): Promise<ScreenSource[]>;
  /** 'linux', 'win32', 'darwin' — decide quem desenha o seletor de tela. */
  platform: string;
  copy(text: string): Promise<void>;
  /**
   * Notificação do sistema por menção.
   *
   * Só aparece com a janela fora de foco — quem decide é o processo main.
   * Daqui é sempre seguro chamar: com o app na frente ela simplesmente não
   * sai, e assim o renderer não precisa saber se tem foco.
   */
  notificarMencao(autor: string, corpo: string): Promise<void>;
  settings: {
    get(): Promise<Settings>;
    patch(patch: Partial<Settings>): Promise<Settings>;
    captureKey(): Promise<KeyBinding | null>;
    cancelKeyCapture(): Promise<void>;
    resolveKey(code: string, printable?: string): Promise<KeyBinding | null>;
    setVolume(identity: string, volume: number): Promise<void>;
    setScreenVolume(identity: string, volume: number): Promise<void>;
    /**
     * A função que já ocupa esta tecla, ou null se estiver livre.
     *
     * Quem sabe é o main, que é dono do settings.json — conferir aqui seria
     * uma segunda cópia da regra, e as duas discordariam na primeira ação
     * nova. `exceto` deixa a ação que está sendo re-vinculada fora da
     * checagem, senão trocar a tecla dela por ela mesma acusaria conflito.
     */
    keyInUse(keycode: number, exceto?: AcaoDeAtalho): Promise<AcaoDeAtalho | 'ptt' | null>;
  };
  onPushToTalk(cb: (down: boolean) => void): () => void;
  /**
   * Atalho global apertado — chega só o NOME da ação.
   *
   * O main não manda "desligue o microfone" porque ele teria que saber se o
   * mic já está ligado, e esse estado mora aqui. Ele avisa que a tecla foi
   * apertada; quem alterna é este lado.
   */
  onAtalho(cb: (acao: AcaoDeAtalho) => void): () => void;
}

declare global {
  interface Window {
    disc: DiscApi;
  }
}
