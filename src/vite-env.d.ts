/// <reference types="vite/client" />

declare module '*.png?inline' {
  const src: string
  export default src
}

interface ImportMetaEnv {
  readonly VITE_GAME_WS_URL?: string
  readonly VITE_DEFAULT_MARKET?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
