import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './style.css';
import './workbench.css';
import './people.css';
import './theme.css';
import './neutral-theme.css';
import './neutral-cards.css';
import './workspace-page.css';

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
