import { getTRIOSAdapter } from '@/lib/trios/adapter'

const versions = {
  extension: null as string | null,
  chromium: null as string | null,
  trios: null as string | null,
}

const adapter = getTRIOSAdapter()
adapter
  .getVersion()
  .then((v) => {
    versions.chromium = v
  })
  .catch(() => {})
adapter
  .getBrowserosVersion()
  .then((v) => {
    versions.trios = v
  })
  .catch(() => {})

/** @public */
export function track(
  eventName: string,
  properties?: Record<string, unknown>,
): void {
  if (!versions.extension) {
    versions.extension = chrome.runtime.getManifest().version
  }

  adapter
    .logMetric(eventName, {
      extension_version: versions.extension,
      ...(versions.chromium && { chromium_version: versions.chromium }),
      ...(versions.trios && { trios_version: versions.trios }),
      ...properties,
    })
    .catch(() => {})
}
