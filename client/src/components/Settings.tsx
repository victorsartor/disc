import { useEffect, useRef, useState } from 'react';
import type { KeyBinding, Settings as SettingsType } from '../types';
import { Select } from './Select';

interface Props {
  settings: SettingsType;
  onPatch: (patch: Partial<SettingsType>) => Promise<SettingsType>;
  onClose: () => void;
}

/** Depois desse tempo sem tecla nenhuma, a captura desiste sozinha. */
const CAPTURE_TIMEOUT = 15000;

export function Settings({ settings, onPatch, onClose }: Props) {
  const [mics, setMics] = useState<MediaDeviceInfo[]>([]);
  const [speakers, setSpeakers] = useState<MediaDeviceInfo[]>([]);
  const [capturing, setCapturing] = useState(false);
  const [justBound, setJustBound] = useState(false);

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
          <button className="btn btn--accent" onClick={onClose}>Fechar</button>
        </div>
      </div>
    </div>
  );
}
