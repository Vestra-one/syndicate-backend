import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App.tsx'
import { useGameStore } from '@/store/gameStore'
import './styles/global.css'

// Dev-only: expose the store for headless inspection / debugging.
if (import.meta.env.DEV) {
  ;(window as unknown as { __store: () => unknown }).__store = useGameStore.getState
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
