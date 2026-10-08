import React from 'react';
import ReactDOM from 'react-dom/client';
import { App } from './app/App';
import { isTauri } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { lazy, Suspense } from 'react';
import './styles/index.css';
import './styles/v2.css';
const Palette = lazy(() =>
  import('./features/command-palette/CommandPalette').then((m) => ({ default: m.CommandPalette })),
);
const isPalette = isTauri() && getCurrentWindow().label === 'palette';
ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    {isPalette ? (
      <Suspense fallback={null}>
        <Palette />
      </Suspense>
    ) : (
      <App />
    )}
  </React.StrictMode>,
);
