export async function acceptDataDisclosure(page, { disableBridge = true } = {}) {
  const accepted = await page.evaluate(async disableBridge => {
    const { qz_data_consent: consent, _qingzhou_mcp_bridge: bridge } = await chrome.storage.local.get([
      "qz_data_consent", "_qingzhou_mcp_bridge",
    ]);
    // Ordinary test profiles must not connect to a developer's running bridge.
    // MCP fixtures exercise the real connection page with this guard disabled.
    if (disableBridge && !bridge) await chrome.storage.local.set({ _qingzhou_mcp_bridge: { enabled: false } });
    return consent?.version === 1 && consent.acceptedAt > 0;
  }, disableBridge);
  if (!accepted) await page.locator("[data-consent-accept]").click();
}
