import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App.tsx'
import { useGameStore } from '@/store/gameStore'
import './styles/global.css'

// Dev-only: expose the store for headless inspection / debugging.
if (import.meta.env.DEV) {
  const w = window as unknown as Record<string, unknown>
  w.__store = useGameStore.getState
  w.__setStore = useGameStore.setState
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
