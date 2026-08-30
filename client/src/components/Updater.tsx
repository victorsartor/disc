import { useEffect, useState } from 'react';
import type { UpdateState } from '../types';
import logo from '../assets/logo.png';

const mb = (bytes: number) => (bytes / 1024 / 1024).toFixed(1);

function Detail({ state }: { state: UpdateState }) {
  if (state.status === 'downloading') {
    return (
      <p className="updater__detail">
        {mb(state.transferred)} de {mb(state.total)} MB
        {state.bytesPerSecond > 0 && ` · ${mb(state.bytesPerSecond)} MB/s`}
      </p>
    );
  }
  if (state.status === 'error') {
    return <p className="updater__detail updater__detail--error">{state.message}</p>;
  }
  return <p className="updater__detail">Não feche o app.</p>;
}

export function Updater({ state, from }: { state: UpdateState; from: string | null }) {
  // Escape para download travado. Acontece de verdade: o relay do Tailscale
  // cai, o servidor reinicia no meio. Sem isto a barra fica parada pra sempre
  // e a pessoa nem consegue usar a versao que ja tem instalada.
  const [showEscape, setShowEscape] = useState(false);
  useEffect(() => {
    const id = setTimeout(() => setShowEscape(true), 20000);
    return () => clearTimeout(id);
  }, []);

  const failed = state.status === 'error';
  const done = state.status === 'ready';
  const percent = state.status === 'downloading' ? state.percent : done ? 100 : null;
  const to = 'version' in state ? state.version : null;

  return (
    <div className="updater">
      <div className="updater__card">
        <img className="updater__mark" src={logo} alt="" />

        <h1 className="updater__title">
          {failed ? 'Não consegui atualizar' : done ? 'Tudo pronto' : 'Atualizando a Disneia'}
        </h1>

        {from && to && (
          <p className="updater__versions">
            <span>{from}</span>
            <span className="updater__arrow">→</span>
            <span className="updater__versions-new">{to}</span>
          </p>
        )}

        {!failed && (
          <div className={`updater__bar ${percent === null ? 'updater__bar--waiting' : ''}`}>
            <div
              className="updater__fill"
              style={percent === null ? undefined : { width: `${percent}%` }}
            />
          </div>
        )}

        {percent !== null && !failed && (
          <p className="updater__percent">{Math.round(percent)}%</p>
        )}

        <Detail state={state} />

        {done && <p className="updater__detail">Reiniciando sozinho…</p>}

        {(failed || showEscape) && !done && (
          <button
            className="btn btn--ghost updater__escape"
            onClick={() => void window.disc.update.skip()}
          >
            Continuar sem atualizar
          </button>
        )}
      </div>
    </div>
  );
}
