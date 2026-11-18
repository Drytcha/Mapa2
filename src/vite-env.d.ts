/// <reference types="vite/client" />

declare module "*.zip?url" {
  const url: string;
  export default url;
}
