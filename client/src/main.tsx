import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
// Inter e JetBrains Mono vem do pacote, nao da rede: o CSP do app e
// default-src 'self' e a janela roda em file://.
import '@fontsource-variable/inter/wght.css';
import '@fontsource-variable/jetbrains-mono/wght.css';
import './theme.css';
// Depois do theme.css por leitura, nao por cascata: os seletores de tema
// tem especificidade maior que o :root de la e ganhariam em qualquer ordem.
import './themes.css';
import './profile.css';

// O tema de verdade mora no settings.json do processo main, mas ele chega
// por IPC — depois da primeira pintura. Esta cópia existe só pra evitar o
// clarão: quem usa o tema claro veria um quadro escuro antes da resposta.
// Se o localStorage estiver indisponível, cai no padrão do theme.css.
try {
  const salvo = localStorage.getItem('tema');
  if (salvo) document.documentElement.dataset.theme = salvo;
} catch {
  /* sem armazenamento: segue no padrão */
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
