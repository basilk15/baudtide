import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '../tokens.css';
import './styles.css';
import App from './App';
import './app-skin.css';
import './terminal-workbench.css';
import './sage-theme.css';
import './components/mobile-share-polish.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
