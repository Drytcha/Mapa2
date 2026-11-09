/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_APP_NAME?: string;
  readonly VITE_OSRM_URL?: string;
  readonly VITE_OSRM_PROFILE?: string;
  readonly VITE_OSRM_BUS_URL?: string;
  readonly VITE_NOMINATIM_URL?: string;
  readonly VITE_OVERPASS_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
