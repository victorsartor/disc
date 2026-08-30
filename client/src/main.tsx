import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
// Inter e JetBrains Mono vem do pacote, nao da rede: o CSP do app e
// default-src 'self' e a janela roda em file://.
import '@fontsource-variable/inter/wght.css';
import '@fontsource-variable/jetbrains-mono/wght.css';
import './theme.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
