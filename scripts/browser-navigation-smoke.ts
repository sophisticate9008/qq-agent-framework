import type { Page } from 'playwright';
import { pageDefinition, pageNavigationGroups, type PageId } from '../web/lib/page-registry.ts';

/** Follow visible registered navigation, including grouped pages and legacy destinations. */
export async function navigateConsolePage(page: Page, destination: PageId): Promise<void> {
  const selected = pageDefinition(destination);
  const group = pageNavigationGroups.find(entry => entry.pages.some(candidate => candidate === selected.id));
  if (!group) throw new Error(`No navigation registered for ${destination}`);
  await page.getByRole('button', { name: group.label, exact: true }).first().click();
  if (group.id !== selected.id) await page.getByRole('button', { name: selected.subpageLabel ?? selected.label, exact: true }).first().click();
  await page.locator(`[data-page="${selected.id}"]`).waitFor();
}
