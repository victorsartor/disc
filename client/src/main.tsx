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
// A largura da barra lateral vem pelo mesmo caminho e pela mesma razão: sem
// esta cópia a coluna abre nos 240px do CSS e pula pro tamanho salvo quando o
// IPC responde. O valor é conferido aqui de novo porque o localStorage é
// editável pelo DevTools, e um NaN aqui invalidaria o grid-template-columns
// e colapsaria a coluna. Os limites de verdade são os de electron/settings.ts.
try {
  const salvo = localStorage.getItem('tema');
  if (salvo) document.documentElement.dataset.theme = salvo;

  const px = Number(localStorage.getItem('larguraSidebar'));
  if (Number.isFinite(px) && px >= 180 && px <= 480) {
    document.documentElement.style.setProperty('--sidebar-w', `${Math.round(px)}px`);
  }
} catch {
  /* sem armazenamento: segue no padrão */
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
