import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './styles/tokens.css';
import './styles/styles.css';
import App from './App';
import './styles/app-skin.css';
import './styles/terminal-workbench.css';
import './styles/sage-theme.css';
import './components/mobile/mobile-share-polish.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
