import { useEffect, useState } from 'react';
import type { Settings as SettingsType } from '../types';

interface Props {
  settings: SettingsType;
  onPatch: (patch: Partial<SettingsType>) => Promise<SettingsType>;
  onClose: () => void;
}

export function Settings({ settings, onPatch, onClose }: Props) {
  const [mics, setMics] = useState<MediaDeviceInfo[]>([]);
  const [speakers, setSpeakers] = useState<MediaDeviceInfo[]>([]);
  const [capturing, setCapturing] = useState(false);
  const [justBound, setJustBound] = useState(false);

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

  const bindKey = async () => {
    // Clicar de novo enquanto escuta cancela, em vez de nao fazer nada.
    if (capturing) {
      await window.disc.settings.cancelKeyCapture();
      return;
    }
    setCapturing(true);
    try {
      const key = await window.disc.settings.captureKey();
      if (key) {
        await onPatch({ pttKeycode: key.keycode, pttKeyLabel: key.label });
        setJustBound(true);
        setTimeout(() => setJustBound(false), 1400);
      }
    } finally {
      setCapturing(false);
    }
  };

  return (
    <div className="modal" onClick={onClose}>
      <div className="modal__box" style={{ width: 'min(520px, 100%)' }} onClick={(e) => e.stopPropagation()}>
        <div className="modal__head">Configurações</div>

        <div className="settings">
          <section className="settings__group">
            <h3 className="settings__title">Voz</h3>

            <label className="settings__row">
              <span className="settings__label">Modo</span>
              <select
                className="settings__select"
                value={settings.voiceMode}
                onChange={(e) => void onPatch({ voiceMode: e.target.value as 'vad' | 'ptt' })}
              >
                <option value="vad">Detecção de voz</option>
                <option value="ptt" disabled={!settings.pttAvailable}>
                  Apertar para falar
                </option>
              </select>
            </label>

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
                    onClick={() => void bindKey()}
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

            <label className="settings__row">
              <span className="settings__label">Microfone</span>
              <select
                className="settings__select"
                value={settings.micDeviceId ?? ''}
                onChange={(e) => void onPatch({ micDeviceId: e.target.value || null })}
              >
                <option value="">Padrão do sistema</option>
                {mics.map((d) => (
                  <option key={d.deviceId} value={d.deviceId}>
                    {d.label || 'Microfone'}
                  </option>
                ))}
              </select>
            </label>

            <label className="settings__row">
              <span className="settings__label">Saída</span>
              <select
                className="settings__select"
                value={settings.speakerDeviceId ?? ''}
                onChange={(e) => void onPatch({ speakerDeviceId: e.target.value || null })}
              >
                <option value="">Padrão do sistema</option>
                {speakers.map((d) => (
                  <option key={d.deviceId} value={d.deviceId}>
                    {d.label || 'Saída'}
                  </option>
                ))}
              </select>
            </label>
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
