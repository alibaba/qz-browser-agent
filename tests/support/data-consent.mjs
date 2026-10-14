export async function acceptDataDisclosure(page) {
  const accepted = await page.evaluate(async () => {
    const { qz_data_consent: consent } = await chrome.storage.local.get("qz_data_consent");
    return consent?.version === 1 && consent.acceptedAt > 0;
  });
  if (!accepted) await page.locator("[data-consent-accept]").click();
}
