export function Login() {
  return (
    <div className="login">
      <div className="login__card">
        <div className="login__mark">C</div>
        <h1 className="login__title">Concord</h1>
        <p className="login__sub">Voz e tela, so pra gente.</p>

        <button className="btn btn--accent" style={{ width: '100%', padding: '11px' }}
                onClick={() => void window.disc.auth.login()}>
          Entrar com Google
        </button>

        <p className="login__note">
          O login abre no seu navegador e volta pro app sozinho.
          <br />
          Só contas na lista de liberados conseguem entrar.
        </p>
      </div>
    </div>
  );
}
