import { useEffect, useRef, useState } from 'react';
import type { Me, UserProfile } from '../types';
import { THEMES, type ThemeId } from '../lib/themes';
import {
  pickImageFile, prepareImage, AVATAR_SPEC, BANNER_SPEC,
} from '../lib/image';
import { IconCamera, IconCheck, IconTrash } from './Icons';

/** Espelha os limites de server/src/profile.ts. */
const MAX_BIO = 300;
const MAX_STATUS = 60;
const MAX_NAME = 32;

interface Props {
  me: Me;
  theme: ThemeId;
  onThemeChange: (theme: ThemeId) => void;
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
export function Profile({ me, theme, onThemeChange, onSaved, onClose }: Props) {
  const [user, setUser] = useState<UserProfile | null>(null);
  const [name, setName] = useState('');
  const [bio, setBio] = useState('');
  const [statusText, setStatusText] = useState('');
  const [saving, setSaving] = useState(false);
  const [busy, setBusy] = useState<'avatar' | 'banner' | null>(null);
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
            busy={busy}
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
  bannerUrl, avatarUrl, name, busy, onPick, onRemove,
}: {
  bannerUrl: string | null;
  avatarUrl: string | null;
  name: string;
  busy: 'avatar' | 'banner' | null;
  onPick: (kind: 'avatar' | 'banner') => void;
  onRemove: (kind: 'avatar' | 'banner') => void;
}) {
  return (
    <div className="capa">
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
 * O cartão de quem não é você: só leitura, aberto ao clicar num nome.
 * O que dá pra fazer aqui é olhar — mexer no perfil dos outros não existe.
 */
export function UserCard({ identity, onClose }: { identity: string; onClose: () => void }) {
  const [user, setUser] = useState<UserProfile | null>(null);
  const [erro, setErro] = useState(false);

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
            <div className="capa">
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
