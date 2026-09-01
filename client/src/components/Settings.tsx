import { useEffect, useRef, useState } from 'react';
import type { KeyBinding, Settings as SettingsType } from '../types';
import { Select } from './Select';

interface Props {
  settings: SettingsType;
  onPatch: (patch: Partial<SettingsType>) => Promise<SettingsType>;
  /** Nível do microfone agora, 0 a 100. null = fora de canal. */
  micLevel: () => number | null;
  onClose: () => void;
}

/**
 * Medidor de entrada com a linha de corte por cima.
 *
 * Sem ver o próprio nível, escolher a sensibilidade é adivinhação: o número
 * não significa nada até você falar e ver onde a barra chega. Com a linha
 * desenhada em cima fica óbvio o que passa e o que fica de fora.
 */
function Medidor({ nivel, corte }: { nivel: number | null; corte: number }) {
  const passando = nivel !== null && nivel >= corte;

  return (
    <div className="medidor">
      <div
        className={`medidor__nivel${passando ? ' medidor__nivel--passa' : ''}`}
        style={{ width: `${nivel ?? 0}%` }}
      />
      <div className="medidor__corte" style={{ left: `${corte}%` }} />
    </div>
  );
}

/**
 * Barrinha de volume de 0 a 100, com o número do lado.
 *
 * O número não é enfeite: sem ele não dá pra saber se você está em 40 ou em
 * 55, e "deixei no mesmo de ontem" vira impossível.
 */
function VolumeRow({
  label,
  value,
  onChange,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
}) {
  return (
    <div className="settings__row settings__row--volume">
      <span className="settings__label">{label}</span>
      <input
        type="range"
        className="volume__slider"
        min={0}
        max={100}
        step={1}
        value={value}
        aria-label={label}
        onChange={(e) => onChange(Number(e.target.value))}
      />
      <span className="volume__value">{value}</span>
    </div>
  );
}

/** Depois desse tempo sem tecla nenhuma, a captura desiste sozinha. */
const CAPTURE_TIMEOUT = 15000;

export function Settings({ settings, onPatch, micLevel, onClose }: Props) {
  const [mics, setMics] = useState<MediaDeviceInfo[]>([]);
  const [speakers, setSpeakers] = useState<MediaDeviceInfo[]>([]);
  const [capturing, setCapturing] = useState(false);
  const [justBound, setJustBound] = useState(false);
  const [nivel, setNivel] = useState<number | null>(null);
  const [versao, setVersao] = useState<string | null>(null);

  // Qual build esta rodando. Parece detalhe, mas sem isso duas builds com o
  // mesmo numero sao indistinguiveis - foi assim que um teste de chamada
  // real com outra pessoa foi gasto testando a versao velha sem ninguem
  // perceber.
  useEffect(() => {
    let vivo = true;
    window.disc.update
      .version()
      .then((v) => { if (vivo) setVersao(v); })
      .catch(() => {});
    return () => { vivo = false; };
  }, []);

  // O medidor só pulsa enquanto esta tela está aberta. Fora daqui ninguém
  // olha, e re-renderizar 20 vezes por segundo à toa custa bateria.
  useEffect(() => {
    const id = window.setInterval(() => setNivel(micLevel()), 50);
    return () => window.clearInterval(id);
  }, [micLevel]);

  // onPatch vem do useRoom e pode trocar de identidade a cada render. Numa
  // dependencia de efeito isso rearmaria a captura no meio dela.
  const patchRef = useRef(onPatch);
  patchRef.current = onPatch;

  useEffect(() => {
    const load = async () => {
      try {
        // Sem permissao concedida os labels vem vazios, entao pedimos antes.
        const probe = await navigator.mediaDevices.getUserMedia({ audio: true });
        probe.getTracks().forEach((t) => t.stop());
      } catch {
        /* segue: os nomes podem vir genericos */
      }
      const devices = await navigator.mediaDevices.enumerateDevices();
      setMics(devices.filter((d) => d.kind === 'audioinput'));
      setSpeakers(devices.filter((d) => d.kind === 'audiooutput'));
    };
    void load();
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && !capturing && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, capturing]);

  /**
   * Captura da tecla do push-to-talk.
   *
   * Caminho principal: keydown do DOM. Enquanto a janela tem foco - que e o
   * caso logo depois do clique no botao - ele dispara para tudo, e o
   * KeyboardEvent.key ainda entrega o caractere do layout do usuario (Ç no
   * ABNT2), coisa que o keycode sozinho nao sabe.
   *
   * Em paralelo corre a captura pelo hook global, que funciona mesmo se a
   * janela perder o foco no meio. Vale o primeiro que chegar; o outro morre
   * no cancelKeyCapture.
   */
  useEffect(() => {
    if (!capturing) return;
    let done = false;

    const finish = async (bind: KeyBinding | null) => {
      if (done) return;
      done = true;
      void window.disc.settings.cancelKeyCapture();
      if (bind) {
        await patchRef.current({ pttKeycode: bind.keycode, pttKeyLabel: bind.label });
        setJustBound(true);
        window.setTimeout(() => setJustBound(false), 1600);
      }
      setCapturing(false);
    };

    const onKeyDown = (e: KeyboardEvent) => {
      // Sem isso o Tab troca o foco e o Espaco reaciona o proprio botao.
      e.preventDefault();
      e.stopPropagation();
      if (e.repeat) return;
      if (e.code === 'Escape') {
        void finish(null);
        return;
      }
      // Tecla que o hook global nao enxerga nao serve pra PTT: ignora e
      // continua escutando, em vez de vincular algo que nunca ia funcionar.
      void window.disc.settings
        .resolveKey(e.code, e.key)
        .then((bind) => bind && finish(bind));
    };

    window.addEventListener('keydown', onKeyDown, true);
    void window.disc.settings.captureKey().then((bind) => bind && finish(bind));
    const timer = window.setTimeout(() => void finish(null), CAPTURE_TIMEOUT);

    return () => {
      done = true;
      window.removeEventListener('keydown', onKeyDown, true);
      window.clearTimeout(timer);
      void window.disc.settings.cancelKeyCapture();
    };
  }, [capturing]);

  const micOptions = [
    { value: '', label: 'Padrão do sistema' },
    ...mics.map((d) => ({ value: d.deviceId, label: d.label || 'Microfone' })),
  ];
  const speakerOptions = [
    { value: '', label: 'Padrão do sistema' },
    ...speakers.map((d) => ({ value: d.deviceId, label: d.label || 'Saída' })),
  ];

  /**
   * Monitores do PipeWire — as "escutas" do que está saindo pela caixa.
   *
   * Aparecem misturados aos microfones na lista de entradas, e o nome é o
   * único jeito de separá-los. O rótulo vem traduzido conforme o idioma do
   * sistema, daí as duas formas.
   */
  const monitores = mics.filter((d) => /monitor|monitor de/i.test(d.label));
  const monitorOptions = [
    { value: '', label: 'Sem som (só vídeo)' },
    ...monitores.map((d) => ({ value: d.deviceId, label: d.label })),
  ];

  /**
   * Dá pra isolar o áudio nesta máquina?
   *
   * Perguntado ao processo main em vez de deduzido do sistema operacional:
   * ser Linux não basta, é preciso que o `pactl` responda. Numa máquina sem
   * ele o interruptor apareceria ligado e não faria nada.
   */
  const [isolamentoDisponivel, setIsolamentoDisponivel] = useState(false);
  useEffect(() => {
    let vivo = true;
    void window.disc.audio
      .disponivel()
      .then((v) => vivo && setIsolamentoDisponivel(v))
      .catch(() => {});
    return () => {
      vivo = false;
    };
  }, []);

  return (
    <div className="modal" onClick={onClose}>
      <div className="modal__box modal__box--narrow" onClick={(e) => e.stopPropagation()}>
        <div className="modal__head">Configurações</div>

        <div className="settings">
          <section className="settings__group">
            <h3 className="settings__title">Voz</h3>

            <div className="settings__row">
              <span className="settings__label">Modo</span>
              <Select
                label="Modo de voz"
                value={settings.voiceMode}
                onChange={(v) => void onPatch({ voiceMode: v as 'vad' | 'ptt' })}
                options={[
                  { value: 'vad', label: 'Detecção de voz' },
                  {
                    value: 'ptt',
                    label: 'Apertar para falar',
                    disabled: !settings.pttAvailable,
                    hint: settings.pttAvailable ? undefined : 'indisponível',
                  },
                ]}
              />
            </div>

            {!settings.pttAvailable && (
              <p className="settings__hint settings__hint--warn">
                Apertar para falar precisa de captura global de teclado, que não
                subiu neste sistema. Em Linux com Wayland isso é bloqueado por
                design — trocar a sessão para X11 resolve.
              </p>
            )}

            {settings.voiceMode === 'ptt' && settings.pttAvailable && (
              <>
                <div className="settings__row">
                  <span className="settings__label">Tecla</span>
                  <button
                    className={`keybind${capturing ? ' keybind--listening' : ''}${
                      justBound ? ' keybind--bound' : ''
                    }`}
                    onClick={() => setCapturing((v) => !v)}
                  >
                    {capturing ? (
                      <>
                        <span className="keybind__pulse" />
                        Aperte qualquer tecla
                      </>
                    ) : settings.pttKeyLabel ? (
                      <>
                        <kbd className="keybind__key">{settings.pttKeyLabel}</kbd>
                        <span className="keybind__hint">trocar</span>
                      </>
                    ) : (
                      'Clique para definir'
                    )}
                  </button>
                </div>

                <p className="settings__hint">
                  {capturing
                    ? 'Escutando... aperte Esc ou clique de novo para cancelar.'
                    : justBound
                      ? 'Tecla salva.'
                      : 'Segure essa tecla para falar, mesmo com o jogo em foco.'}
                </p>
              </>
            )}
          </section>

          <section className="settings__group">
            <h3 className="settings__title">Sensibilidade do microfone</h3>

            <Medidor nivel={nivel} corte={settings.micSensitivity} />

            <input
              type="range"
              className="volume__slider"
              min={0}
              max={60}
              step={1}
              value={settings.micSensitivity}
              aria-label="Sensibilidade do microfone"
              onChange={(e) => void onPatch({ micSensitivity: Number(e.target.value) })}
            />

            <p className="settings__hint">
              {nivel === null
                ? 'Entre num canal de voz para ver o medidor se mexer.'
                : settings.micSensitivity === 0
                  ? 'Portão desligado: tudo que o microfone captar vai pro ar.'
                  : 'Só passa o que ultrapassar a linha. Fale normal e suba até o '
                    + 'ruído de fundo parar de acender a barra.'}
            </p>

            {settings.voiceMode === 'ptt' && (
              <p className="settings__hint settings__hint--warn">
                Em apertar para falar o portão não age — quem decide é a tecla.
              </p>
            )}
          </section>

          <section className="settings__group">
            <h3 className="settings__title">Tratamento do som</h3>

            <label className="settings__row">
              <span className="settings__label">Supressão de ruído</span>
              <input
                type="checkbox"
                className="settings__check"
                checked={settings.noiseSuppression}
                onChange={(e) => void onPatch({ noiseSuppression: e.target.checked })}
              />
            </label>

            <label className="settings__row">
              <span className="settings__label">Cancelamento de eco</span>
              <input
                type="checkbox"
                className="settings__check"
                checked={settings.echoCancellation}
                onChange={(e) => void onPatch({ echoCancellation: e.target.checked })}
              />
            </label>

            <label className="settings__row">
              <span className="settings__label">Ganho automático</span>
              <input
                type="checkbox"
                className="settings__check"
                checked={settings.autoGainControl}
                onChange={(e) => void onPatch({ autoGainControl: e.target.checked })}
              />
            </label>

            <p className="settings__hint">
              O ganho automático nivela sua voz — e, nas pausas, amplifica o
              silêncio junto. Se o microfone parecer pegar tudo mesmo com o
              portão ajustado, desligue este primeiro.
            </p>
          </section>

          <section className="settings__group">
            <h3 className="settings__title">Sons</h3>

            <VolumeRow
              label="Voz das pessoas"
              value={settings.voiceVolume}
              onChange={(v) => void onPatch({ voiceVolume: v })}
            />
            <p className="settings__hint">
              Vale pra call inteira. O volume de cada pessoa, no botão direito
              sobre o nome dela, continua valendo por cima deste.
            </p>

            <VolumeRow
              label="Efeitos"
              value={settings.effectsVolume}
              onChange={(v) => void onPatch({ effectsVolume: v })}
            />
            <p className="settings__hint">
              {settings.effectsVolume === 0
                ? 'Sem som ao entrar, sair, compartilhar tela ou chegar mensagem.'
                : 'Entrar e sair da call, começar e parar de compartilhar tela, '
                  + 'e o aviso de mensagem nova.'}
            </p>

            <VolumeRow
              label="Áudio do chat"
              value={settings.chatVolume}
              onChange={(v) => void onPatch({ chatVolume: v })}
            />
            <p className="settings__hint">
              Os áudios que as pessoas mandam no chat. Não mexe na voz de
              ninguém na call.
            </p>
          </section>

          <section className="settings__group">
            <h3 className="settings__title">Dispositivos</h3>

            <div className="settings__row">
              <span className="settings__label">Microfone</span>
              <Select
                label="Microfone"
                value={settings.micDeviceId ?? ''}
                options={micOptions}
                onChange={(v) => void onPatch({ micDeviceId: v || null })}
              />
            </div>

            <div className="settings__row">
              <span className="settings__label">Saída</span>
              <Select
                label="Saída de áudio"
                value={settings.speakerDeviceId ?? ''}
                options={speakerOptions}
                onChange={(v) => void onPatch({ speakerDeviceId: v || null })}
              />
            </div>
          </section>

          {/* Nos dois sistemas, por caminhos diferentes — só o macOS fica de
              fora, onde nada disso existe. */}
          {window.disc.platform !== 'darwin' && (
            <section className="settings__group">
              <h3 className="settings__title">Som ao compartilhar tela</h3>

              {window.disc.platform === 'linux' && (
                <p className="settings__hint">
                  No Linux o som não vem junto com a tela — ele é gravado à parte,
                  de um &quot;monitor&quot;, que é uma escuta do que sai pela sua
                  caixa de som.
                </p>
              )}

              <label className="settings__row">
                <span className="settings__label">Tirar a Disneia do som transmitido</span>
                <input
                  type="checkbox"
                  className="settings__check"
                  checked={settings.isolarAudioNaTela}
                  disabled={!isolamentoDisponivel}
                  onChange={(e) => void onPatch({ isolarAudioNaTela: e.target.checked })}
                />
              </label>

              {isolamentoDisponivel ? (
                <p className="settings__hint">
                  {window.disc.platform === 'linux'
                    ? `Ligado, o jogo passa a tocar num destino separado enquanto
                       você transmite, e é dele que o som sai pra sala — a voz das
                       pessoas fica de fora. Você continua ouvindo tudo normal, e
                       quando a transmissão acaba o áudio volta como estava.`
                    : `Ligado, o som que vai pra sala é gravado direto do Windows
                       já sem a Disneia dentro — a voz das pessoas fica de fora e
                       quem te assiste para de se ouvir de volta. Nada muda no que
                       você escuta.`}
                </p>
              ) : (
                <p className="settings__hint settings__hint--warn">
                  {window.disc.platform === 'linux'
                    ? `Não deu pra falar com o servidor de som desta máquina
                       (o pactl não respondeu), então o isolamento fica
                       indisponível e o som vai pelo caminho de sempre.`
                    : `O componente de áudio não veio nesta instalação, então o
                       isolamento fica indisponível e o som da tela vai do jeito
                       antigo — com a voz da chamada junto.`}
                </p>
              )}

              {/* O seletor de monitor é só do Linux: no Windows o som da tela
                  vem junto com a captura e não há de onde escolher. Aqui ele
                  é o caminho de reserva, pra quando o isolamento está
                  desligado ou falha na hora. */}
              {window.disc.platform === 'linux' && (
                <>
                  <div className="settings__row">
                    <span className="settings__label">
                      {settings.isolarAudioNaTela ? 'Se não der, gravar de' : 'Gravar de'}
                    </span>
                    <Select
                      label="Som ao compartilhar tela"
                      value={settings.screenAudioDeviceId ?? ''}
                      options={monitorOptions}
                      onChange={(v) => void onPatch({ screenAudioDeviceId: v || null })}
                    />
                  </div>

                  {monitores.length === 0 ? (
                    <p className="settings__hint settings__hint--warn">
                      Nenhum monitor apareceu. Costuma ser o PipeWire não estar
                      expondo a escuta da saída — sem isso, só dá pra compartilhar
                      sem som por aqui.
                    </p>
                  ) : !settings.isolarAudioNaTela ? (
                    <p className="settings__hint settings__hint--warn">
                      Atenção ao eco: o monitor grava TUDO que sai pela sua caixa,
                      e a voz das outras pessoas também sai por ela. Do jeito
                      simples, quem te ouve vai se ouvir de volta.
                    </p>
                  ) : null}
                </>
              )}
            </section>
          )}

          <section className="settings__group">
            <h3 className="settings__title">Overlay</h3>
            <label className="settings__row">
              <span className="settings__label">Mostrar durante o jogo</span>
              <input
                type="checkbox"
                className="settings__check"
                checked={settings.overlayEnabled}
                onChange={(e) => void onPatch({ overlayEnabled: e.target.checked })}
              />
            </label>
            <p className="settings__hint">
              Aparece só quando você está numa sala. Ctrl+Shift+O liga e desliga.
            </p>
          </section>
        </div>

        <div className="modal__foot">
          <span className="settings__versao">{versao ? `Disneia ${versao}` : ''}</span>
          <button className="btn btn--accent" onClick={onClose}>Fechar</button>
        </div>
      </div>
    </div>
  );
}
