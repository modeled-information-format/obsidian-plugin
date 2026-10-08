// Injected by esbuild (esbuild.config.mjs `define`); "dev" under tests.
declare const __MIF_BUILD__: string | undefined;

export const BUILD_ID: string = typeof __MIF_BUILD__ === "string" ? __MIF_BUILD__ : "dev";
