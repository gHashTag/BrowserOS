/**
 * @public
 */
export async function openSidePanel(
  tabId: number,
): Promise<{ opened: boolean }> {
  // @ts-expect-error triosIsOpen is a TRIOS-specific API
  const isAlreadyOpen = await chrome.sidePanel.triosIsOpen({ tabId })
  if (isAlreadyOpen) {
    return { opened: true }
  }
  // @ts-expect-error triosToggle is a TRIOS-specific API
  return await chrome.sidePanel.triosToggle({ tabId })
}

/**
 * @public
 */
export async function toggleSidePanel(
  tabId: number,
): Promise<{ opened: boolean }> {
  // @ts-expect-error triosToggle is a TRIOS-specific API
  return await chrome.sidePanel.triosToggle({ tabId })
}
