import { useEffect, useState } from 'react';
import type { WhipConfig } from '../types';

interface Props {
  channelId: string;
  channelName: string;
  onClose: () => void;
}

export function ObsSetup({ channelId, channelName, onClose }: Props) {
  const [cfg, setCfg] = useState<WhipConfig | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  useEffect(() => {
    window.disc
      .whipConfig(channelId)
      .then(setCfg)
      .catch((e) => setError(e instanceof Error ? e.message : 'falha ao gerar token'));
  }, [channelId]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const copy = async (label: string, value: string) => {
    await window.disc.copy(value);
    setCopied(label);
    setTimeout(() => setCopied(null), 1600);
  };

  return (
    <div className="modal" onClick={onClose}>
      <div className="modal__box" style={{ width: 'min(600px, 100%)' }} onClick={(e) => e.stopPropagation()}>
        <div className="modal__head">Transmitir pelo OBS — {channelName}</div>

        <div className="settings">
          <p className="settings__hint">
            Use este caminho para jogo pesado: o OBS encoda por hardware (NVENC),
            então não custa FPS, e o Game Capture funciona mesmo com o jogo em
            fullscreen exclusivo.
          </p>

          {error && <p className="settings__hint settings__hint--warn">{error}</p>}

          {!cfg ? (
            <p className="settings__hint">Gerando credenciais...</p>
          ) : (
            <>
              <section className="settings__group">
                <h3 className="settings__title">1. No OBS: Configurações → Transmissão</h3>

                <div className="field">
                  <span className="field__label">Serviço</span>
                  <code className="field__value">WHIP</code>
                </div>

                <div className="field">
                  <span className="field__label">Servidor</span>
                  <code className="field__value field__value--mono">{cfg.endpoint}</code>
                  <button className="btn btn--ghost btn--sm" onClick={() => void copy('url', cfg.endpoint)}>
                    {copied === 'url' ? 'Copiado' : 'Copiar'}
                  </button>
                </div>

                <div className="field">
                  <span className="field__label">Chave (Bearer)</span>
                  <code className="field__value field__value--mono">
                    {cfg.bearerToken.slice(0, 22)}…
                  </code>
                  <button className="btn btn--ghost btn--sm" onClick={() => void copy('token', cfg.bearerToken)}>
                    {copied === 'token' ? 'Copiado' : 'Copiar'}
                  </button>
                </div>

                <p className="settings__hint">
                  A chave vale 2 horas e é só desta sala. Depois disso, é só abrir
                  esta janela de novo para gerar outra.
                </p>
              </section>

              <section className="settings__group">
                <h3 className="settings__title">2. Configurações → Saída (modo avançado)</h3>
                <div className="field"><span className="field__label">Encoder</span><code className="field__value">NVIDIA NVENC H.264</code></div>
                <div className="field"><span className="field__label">Controle de taxa</span><code className="field__value">CBR</code></div>
                <div className="field"><span className="field__label">Bitrate</span><code className="field__value">20000 a 30000 Kbps</code></div>
                <div className="field"><span className="field__label">Intervalo de keyframe</span><code className="field__value">1 s</code></div>
                <div className="field"><span className="field__label">Preset</span><code className="field__value">P5 / Qualidade</code></div>
                <div className="field"><span className="field__label">Tuning</span><code className="field__value">Baixa latência</code></div>
              </section>

              <section className="settings__group">
                <h3 className="settings__title">3. Configurações → Vídeo</h3>
                <div className="field"><span className="field__label">Resolução de saída</span><code className="field__value">2560×1440 ou 1920×1080</code></div>
                <div className="field"><span className="field__label">FPS</span><code className="field__value">60</code></div>
                <p className="settings__hint">
                  Enquanto o OBS estiver transmitindo, você aparece na sala como
                  uma segunda fonte de tela. Continue no app normalmente para a voz.
                </p>
              </section>
            </>
          )}
        </div>

        <div className="modal__foot">
          <button className="btn btn--accent" onClick={onClose}>Fechar</button>
        </div>
      </div>
    </div>
  );
}
