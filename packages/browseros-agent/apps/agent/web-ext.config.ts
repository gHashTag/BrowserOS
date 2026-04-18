import { defineWebExtConfig } from 'wxt'

// biome-ignore lint/style/noProcessEnv: config file needs env access
const env = process.env

const chromiumArgs = [
  '--use-mock-keychain',
  '--show-component-extension-options',
  '--disable-trios-server',
  '--disable-browseros-extensions',
]

if (env.trios_CDP_PORT) {
  // TODO: replace with --browseros-cdp-port once we fix the browseros bug
  chromiumArgs.push(`--remote-debugging-port=${env.trios_CDP_PORT}`)
  // chromiumArgs.push(`--browseros-cdp-port =${env.trios_CDP_PORT}`)
}
if (env.trios_SERVER_PORT) {
  chromiumArgs.push(`--browseros-mcp-port=${env.trios_SERVER_PORT}`)
  chromiumArgs.push(`--trios-server-port=${env.trios_SERVER_PORT}`)
  // --disable-trios-server means no proxy is running, so proxy port falls back to server port
  chromiumArgs.push(`--browseros-proxy-port=${env.trios_SERVER_PORT}`)
}
if (env.trios_EXTENSION_PORT) {
  chromiumArgs.push(`--browseros-extension-port=${env.trios_EXTENSION_PORT}`)
}

export default defineWebExtConfig({
  // biome-ignore lint/suspicious/noExplicitAny: WXT supports 'disabled' at runtime but not in types
  disabled: true as any,
  binaries: {
    chrome:
      env.trios_BINARY ||
      '/Applications/BrowserOS.app/Contents/MacOS/BrowserOS',
  },
  chromiumArgs,
  chromiumProfile: env.trios_USER_DATA_DIR || '/tmp/browseros-dev',
  keepProfileChanges: true,
  startUrls: ['chrome://newtab'],
})
