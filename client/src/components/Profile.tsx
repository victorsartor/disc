import { useEffect, useRef, useState } from 'react';
import type { Me, StatusEscolhido, UserProfile } from '../types';
import { THEMES, type ThemeId } from '../lib/themes';
import { EFEITOS, classeDoEfeito, type EfeitoId } from '../lib/efeitos';
import {
  pickImageFile, prepareImage, AVATAR_SPEC, BANNER_SPEC,
} from '../lib/image';
import { IconCamera, IconCheck, IconTrash } from './Icons';
import { StatusPicker } from './StatusPicker';

/** Espelha os limites de server/src/profile.ts. */
const MAX_BIO = 300;
const MAX_STATUS = 60;
const MAX_NAME = 32;

/**
 * O acumulado de call, do jeito que a frase pede.
 *
 * Abaixo de uma hora vai em minutos, porque "0h" pra quem entrou ontem
 * parece que o contador está quebrado. Acima, horas cheias e nada de
 * decimal: "passou mais de 67h" é a frase, e "67,4h" seria uma precisão
 * que ninguém pediu num número que só cresce.
 */
export function tempoEmCall(ms: number): string {
  const minutos = Math.floor(ms / 60_000);
  if (minutos < 1) return 'menos de um minuto';
  if (minutos < 60) return `${minutos} min`;
  return `${Math.floor(minutos / 60).toLocaleString('pt-BR')}h`;
}

interface Props {
  me: Me;
  theme: ThemeId;
  onThemeChange: (theme: ThemeId) => void;
  /** O status que você escolheu — o seletor mostra este, não o efetivo. */
  statusEscolhido: StatusEscolhido;
  onStatusChange: (status: StatusEscolhido) => void;
  /** Devolve o perfil salvo pro App atualizar a foto na sidebar e no chat. */
  onSaved: (user: UserProfile) => void;
  onClose: () => void;
}

/**
 * A aba de perfil: sua foto, sua capa, seu recado e o tema do app.
 *
 * Texto salva no botão; imagem e tema salvam na hora. A diferença é
 * proposital — foto e tema você julga vendo, e ver exige já ter aplicado.
 * Escrever, não: um rascunho pela metade não deveria virar o seu perfil.
 */
export function Profile({
  me, theme, onThemeChange, statusEscolhido, onStatusChange, onSaved, onClose,
}: Props) {
  const [user, setUser] = useState<UserProfile | null>(null);
  const [name, setName] = useState('');
  const [bio, setBio] = useState('');
  const [statusText, setStatusText] = useState('');
  const [saving, setSaving] = useState(false);
  const [busy, setBusy] = useState<'avatar' | 'banner' | null>(null);
  const [salvandoEfeito, setSalvandoEfeito] = useState(false);
  const [erro, setErro] = useState<string | null>(null);

  // Fica true quando o texto na tela deixa de ser o texto do servidor. É o
  // que decide se o botão Salvar tem o que salvar.
  const sujo = Boolean(user) && (
    name !== user!.name || bio !== user!.bio || statusText !== user!.statusText
  );

  useEffect(() => {
    let vivo = true;
    window.disc.profile
      .of(me.id)
      .then(({ user }) => {
        if (!vivo) return;
        setUser(user);
        setName(user.name);
        setBio(user.bio);
        setStatusText(user.statusText);
      })
      .catch(() => vivo && setErro('não consegui carregar seu perfil'));
    return () => {
      vivo = false;
    };
  }, [me.id]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  /** Aplica o que voltou do servidor aqui e lá fora, de uma vez só. */
  const aplicar = (u: UserProfile) => {
    setUser(u);
    setName(u.name);
    setBio(u.bio);
    setStatusText(u.statusText);
    onSaved(u);
  };

  const trocarImagem = async (kind: 'avatar' | 'banner') => {
    const file = await pickImageFile();
    if (!file) return;

    setBusy(kind);
    setErro(null);
    try {
      const dataUrl = await prepareImage(
        file,
        kind === 'avatar' ? AVATAR_SPEC : BANNER_SPEC,
      );
      const { user } = await window.disc.profile.image(kind, dataUrl);
      aplicar(user);
    } catch (err) {
      setErro((err as Error).message || 'não consegui subir essa imagem');
    } finally {
      setBusy(null);
    }
  };

  /**
   * Efeito salva na HORA, como a foto e o tema — e ao contrário do texto.
   *
   * A diferença é a mesma do resto da tela: efeito você julga vendo, e ver
   * exige já ter aplicado. Não existe rascunho de movimento.
   */
  const trocarEfeito = async (efeito: EfeitoId) => {
    if (user?.profileEffect === efeito) return;
    setSalvandoEfeito(true);
    setErro(null);
    try {
      const { user: novo } = await window.disc.profile.patch({ profileEffect: efeito });
      // Só o `user`, e não o aplicar(): os campos de texto podem estar com
      // rascunho, e escolher um efeito não pode jogar fora o que a pessoa
      // estava escrevendo na bio. Escolher efeito é justamente uma atividade
      // de ficar clicando pra ver qual fica melhor.
      setUser(novo);
      onSaved(novo);
    } catch (err) {
      setErro((err as Error).message || 'não consegui trocar o efeito');
    } finally {
      setSalvandoEfeito(false);
    }
  };

  const removerImagem = async (kind: 'avatar' | 'banner') => {
    setBusy(kind);
    setErro(null);
    try {
      const { user } = await window.disc.profile.image(kind, null);
      aplicar(user);
    } catch (err) {
      setErro((err as Error).message || 'não consegui remover');
    } finally {
      setBusy(null);
    }
  };

  const salvar = async () => {
    setSaving(true);
    setErro(null);
    try {
      const { user } = await window.disc.profile.patch({ name, bio, statusText });
      aplicar(user);
      onClose();
    } catch (err) {
      setErro((err as Error).message || 'não consegui salvar');
      setSaving(false);
    }
  };

  return (
    <div className="modal" onClick={onClose}>
      <div
        className="modal__box modal__box--narrow profile"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="profile__bar">
          <button className="btn btn--ghost btn--sm" onClick={onClose}>
            {sujo ? 'Descartar' : 'Fechar'}
          </button>
          <span className="profile__bar-title">Perfil</span>
          <button
            className="btn btn--accent btn--sm"
            onClick={() => void salvar()}
            disabled={!user || saving || !sujo || !name.trim()}
          >
            {saving ? 'Salvando...' : 'Salvar'}
          </button>
        </div>

        <div className="profile__scroll">
          <Cover
            bannerUrl={user?.bannerUrl ?? null}
            avatarUrl={user?.avatarUrl ?? me.avatarUrl}
            name={user?.name ?? me.name}
            efeito={user?.profileEffect}
            busy={busy}
            statusEscolhido={statusEscolhido}
            onStatusChange={onStatusChange}
            onPick={(kind) => void trocarImagem(kind)}
            onRemove={(kind) => void removerImagem(kind)}
          />

          <div className="profile__identity">
            <input
              className="profile__name profile__name--input"
              value={name}
              maxLength={MAX_NAME}
              placeholder="Seu apelido"
              onChange={(e) => setName(e.target.value)}
            />
            <input
              className="profile__status"
              value={statusText}
              maxLength={MAX_STATUS}
              placeholder="Escreva um recado..."
              onChange={(e) => setStatusText(e.target.value)}
            />
          </div>

          {erro && <p className="profile__erro">{erro}</p>}

          {user && <TempoEmCall ms={user.voiceMs} />}

          <section className="profile__card">
            <div className="profile__card-head">
              <h3 className="settings__title">Efeito do perfil</h3>
              <span className="profile__contador">todo mundo vê</span>
            </div>

            <div className="temas">
              {EFEITOS.map((e) => (
                <button
                  key={e.id}
                  className={`tema${user?.profileEffect === e.id ? ' tema--ativo' : ''}`}
                  onClick={() => void trocarEfeito(e.id)}
                  aria-pressed={user?.profileEffect === e.id}
                  disabled={!user || salvandoEfeito}
                  title={`${e.name} — ${e.hint}`}
                >
                  {/* A bolinha mostra o efeito rodando, não uma cor: é o
                      único jeito de escolher movimento sem aplicar antes. */}
                  <span className={`tema__bola efeito-previa efeito-previa--${e.id}`}>
                    {user?.profileEffect === e.id && <IconCheck size={18} />}
                  </span>
                  <span className="tema__nome">{e.name}</span>
                </button>
              ))}
            </div>
          </section>

          <section className="profile__card">
            <div className="profile__card-head">
              <h3 className="settings__title">Sobre mim</h3>
              <span className="profile__contador">
                {bio.length}/{MAX_BIO}
              </span>
            </div>
            <textarea
              className="profile__bio"
              value={bio}
              maxLength={MAX_BIO}
              placeholder="Conte alguma coisa sobre você..."
              onChange={(e) => setBio(e.target.value)}
            />
          </section>

          <section className="profile__card">
            <div className="profile__card-head">
              <h3 className="settings__title">Tema do app</h3>
              <span className="profile__contador">só nesta máquina</span>
            </div>

            <div className="temas">
              {THEMES.map((t) => (
                <button
                  key={t.id}
                  className={`tema${theme === t.id ? ' tema--ativo' : ''}`}
                  onClick={() => onThemeChange(t.id)}
                  aria-pressed={theme === t.id}
                  title={`${t.name} — ${t.hint}`}
                >
                  <span className="tema__bola" style={{ background: t.swatch }}>
                    {theme === t.id && <IconCheck size={18} />}
                  </span>
                  <span className="tema__nome">{t.name}</span>
                </button>
              ))}
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}

/**
 * A capa com a foto por cima, do jeito que o DESIGN.md pede: a foto invade
 * a capa e o texto começa abaixo dela. As duas trocam pelo mesmo botão de
 * câmera, cada uma no seu canto.
 */
function Cover({
  bannerUrl, avatarUrl, name, efeito, busy,
  statusEscolhido, onStatusChange, onPick, onRemove,
}: {
  bannerUrl: string | null;
  avatarUrl: string | null;
  name: string;
  /** Id do efeito vindo do servidor. Validado antes de virar classe. */
  efeito?: string;
  busy: 'avatar' | 'banner' | null;
  statusEscolhido: StatusEscolhido;
  onStatusChange: (status: StatusEscolhido) => void;
  onPick: (kind: 'avatar' | 'banner') => void;
  onRemove: (kind: 'avatar' | 'banner') => void;
}) {
  const capaRef = useParallax(efeito);

  return (
    <div className={`capa ${classeDoEfeito(efeito)}`.trim()} ref={capaRef}>
      <div
        className={`capa__banner${bannerUrl ? '' : ' capa__banner--vazio'}`}
        style={bannerUrl ? { backgroundImage: `url("${cssUrl(bannerUrl)}")` } : undefined}
      >
        <div className="capa__acoes">
          {bannerUrl && (
            <button
              className="capa__btn"
              onClick={() => onRemove('banner')}
              disabled={busy !== null}
              title="Remover capa"
            >
              <IconTrash size={15} />
            </button>
          )}
          <button
            className="capa__btn"
            onClick={() => onPick('banner')}
            disabled={busy !== null}
            title="Trocar a capa"
          >
            {busy === 'banner' ? <span className="capa__spinner" /> : <IconCamera size={15} />}
          </button>
        </div>
      </div>

      <div className="capa__foto">
        <Avatar url={avatarUrl} name={name} size={104} className="avatar--grande" />

        {/* O status mora aqui, no canto oposto à câmera: trocar o seu
            status é assunto de perfil, e no rodapé da coluna a bolinha
            ficava sozinha numa linha só dela, sem dizer o que era. */}
        <div className="capa__status">
          <StatusPicker
            escolhido={statusEscolhido}
            onChange={onStatusChange}
            direcao="baixo"
            grande
          />
        </div>

        <button
          className="capa__btn capa__btn--foto"
          onClick={() => onPick('avatar')}
          disabled={busy !== null}
          title="Trocar a foto"
        >
          {busy === 'avatar' ? <span className="capa__spinner" /> : <IconCamera size={14} />}
        </button>
      </div>
    </div>
  );
}

/**
 * O acumulado de horas em call.
 *
 * Some por completo enquanto ninguém tem tempo nenhum: uma faixa dizendo
 * "0 min em chamadas" no cartão de quem acabou de entrar é ruído, não
 * informação. Ela nasce sozinha assim que a pessoa passa o primeiro minuto.
 *
 * "Passou mais de" e não "passou": o número é somado de 30 em 30 segundos,
 * então ele é um piso, não uma medida exata — e a frase diz isso em vez de
 * fingir precisão.
 */
function TempoEmCall({ ms, nome }: { ms: number; nome?: string }) {
  if (!ms || ms < 60_000) return null;

  return (
    <p className="profile__tempo">
      <span className="profile__tempo-valor">{tempoEmCall(ms)}</span>
      {nome ? ` — foi o que ${nome} passou em chamadas` : ' em chamadas até agora'}
    </p>
  );
}

/**
 * O parallax da capa: o único efeito que precisa de JavaScript.
 *
 * Os outros quatro são keyframes puras. Este depende de ONDE o ponteiro
 * está, então escuta o movimento e escreve duas variáveis que o CSS
 * consome — o cálculo mora aqui, a aparência continua no profile.css.
 *
 * O listener é do ELEMENTO, não da window: fora do cartão não existe
 * parallax pra atualizar, e um listener global rodaria a cada pixel do
 * mouse na tela inteira. O cleanup é o que impede que abrir e fechar o
 * perfil dez vezes deixe dez listeners pendurados.
 *
 * Quem liga "reduzir movimento" no sistema não ganha listener nenhum. O CSS
 * já ignoraria as variáveis, e calcular pra ninguém é desperdício.
 */
function useParallax(efeito?: string) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el || efeito !== 'parallax') return;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

    const mover = (e: PointerEvent) => {
      const r = el.getBoundingClientRect();
      // -1 a 1 nos dois eixos, com o centro da capa no zero.
      el.style.setProperty('--px', (((e.clientX - r.left) / r.width) * 2 - 1).toFixed(3));
      el.style.setProperty('--py', (((e.clientY - r.top) / r.height) * 2 - 1).toFixed(3));
    };
    // Sair sem zerar deixaria a capa torta no último ângulo pra sempre.
    const sair = () => {
      el.style.setProperty('--px', '0');
      el.style.setProperty('--py', '0');
    };

    el.addEventListener('pointermove', mover);
    el.addEventListener('pointerleave', sair);
    return () => {
      el.removeEventListener('pointermove', mover);
      el.removeEventListener('pointerleave', sair);
    };
  }, [efeito]);

  return ref;
}

/**
 * O cartão de quem não é você: só leitura, aberto ao clicar num nome.
 * O que dá pra fazer aqui é olhar — mexer no perfil dos outros não existe.
 */
export function UserCard({ identity, onClose }: { identity: string; onClose: () => void }) {
  const [user, setUser] = useState<UserProfile | null>(null);
  const [erro, setErro] = useState(false);
  const capaRef = useParallax(user?.profileEffect);

  useEffect(() => {
    let vivo = true;
    setUser(null);
    setErro(false);
    window.disc.profile
      .of(identity)
      .then(({ user }) => vivo && setUser(user))
      .catch(() => vivo && setErro(true));
    return () => {
      vivo = false;
    };
  }, [identity]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="modal" onClick={onClose}>
      <div
        className="modal__box modal__box--narrow profile"
        onClick={(e) => e.stopPropagation()}
      >
        {erro ? (
          <div className="empty">Não consegui carregar esse perfil.</div>
        ) : !user ? (
          <div className="empty">Carregando...</div>
        ) : (
          <div className="profile__scroll">
            <div className={`capa ${classeDoEfeito(user.profileEffect)}`.trim()} ref={capaRef}>
              <div
                className={`capa__banner${user.bannerUrl ? '' : ' capa__banner--vazio'}`}
                style={
                  user.bannerUrl
                    ? { backgroundImage: `url("${cssUrl(user.bannerUrl)}")` }
                    : undefined
                }
              />
              <div className="capa__foto">
                <Avatar url={user.avatarUrl} name={user.name} size={104} className="avatar--grande" />
              </div>
            </div>

            <div className="profile__identity">
              <h2 className="profile__name">{user.name}</h2>
              {user.statusText && <p className="profile__recado">{user.statusText}</p>}
            </div>

            <TempoEmCall ms={user.voiceMs} nome={user.name} />

            {user.bio && (
              <section className="profile__card">
                <h3 className="settings__title">Sobre mim</h3>
                <p className="profile__bio-lida">{user.bio}</p>
              </section>
            )}
          </div>
        )}

        <div className="modal__foot">
          <button className="btn btn--ghost" onClick={onClose}>Fechar</button>
        </div>
      </div>
    </div>
  );
}

/**
 * Foto de perfil com plano B: quem nunca subiu foto e não tem a do Google
 * cai na inicial do nome, e não num retângulo quebrado.
 */
export function Avatar({
  url, name, size, className = '',
}: {
  url: string | null;
  name: string;
  size: number;
  className?: string;
}) {
  const [falhou, setFalhou] = useState(false);

  // Uma URL nova merece uma tentativa nova — sem isto, trocar a foto depois
  // de um erro deixaria a inicial no lugar pra sempre.
  const anterior = useRef(url);
  if (anterior.current !== url) {
    anterior.current = url;
    if (falhou) setFalhou(false);
  }

  const style = { width: size, height: size };

  if (!url || falhou) {
    return (
      <span
        className={`avatar avatar--inicial ${className}`}
        style={{ ...style, fontSize: Math.round(size * 0.4) }}
        aria-hidden
      >
        {name.trim().charAt(0).toUpperCase() || '?'}
      </span>
    );
  }

  return (
    <img
      className={`avatar ${className}`}
      style={style}
      src={url}
      alt=""
      referrerPolicy="no-referrer"
      onError={() => setFalhou(true)}
    />
  );
}

/** Escapa aspas dentro de url() em vez de deixar a regra inteira quebrar. */
function cssUrl(url: string): string {
  return url.replace(/["\\]/g, '\\$&');
}
