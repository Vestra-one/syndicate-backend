/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_GAME_WS_URL?: string
  readonly VITE_DEFAULT_MARKET?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
