declare module "node:*" {
  const value: any;
  export default value;
}
declare const process: any;
declare const Buffer: any;
declare const fetch: any;
declare const WebSocket: any;
declare const structuredClone: any;
declare namespace NodeJS {
  interface Timeout {}
}
